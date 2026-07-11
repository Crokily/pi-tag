/**
 * Slack channel adapter.
 *
 * Architecture borrowed from NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Handles all Slack I/O over Socket Mode: receiving messages, sending
 * responses, busy reactions. Contains zero business logic — that lives in
 * the pi agent.
 */

import { App, LogLevel, type SlackEventMiddlewareArgs } from '@slack/bolt';
import { type AttachmentMeta, type RegisteredChannel } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  createDmChannel,
  getChannel,
  registerChannel as dbRegisterChannel,
  enqueueMessage,
} from '../db.js';
import {
  buildAttachmentOnlyPrompt,
  selectAttachmentsWithinLimits,
} from '../platform/attachments.js';
import { registerCommands } from './commands.js';

/** Inbound message event shape as delivered by Bolt's message listener. */
type InboundMessageEvent = SlackEventMiddlewareArgs<'message'>['message'];

let app: App | null = null;
let triggerPattern: RegExp;
let botUserId: string;
let botTag: string | undefined;
let teamName: string | undefined;

/** userId → display name, populated lazily via users.info */
const userNameCache = new Map<string, string>();

export async function startSlack(): Promise<void> {
  const boltApp = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    // Keep Bolt's console logger out of pino's way unless we are debugging.
    logLevel:
      config.logLevel === 'debug' || config.logLevel === 'trace' ? LogLevel.DEBUG : LogLevel.WARN,
  });

  boltApp.error(async (err) => {
    logger.error({ err: err.message }, 'Slack client error');
  });

  boltApp.message(async ({ message }) => {
    try {
      await handleMessage(message);
    } catch (err: any) {
      logger.error({ err: err.message, ts: message.ts }, 'Message handler failed');
    }
  });
  registerCommands(boltApp);

  // auth.test gives us our own identity: needed for loop prevention (never
  // react to our own messages) and for mention → trigger normalization.
  const auth = await boltApp.client.auth.test();
  botUserId = auth.user_id ?? '';
  teamName = auth.team;
  botTag = `${auth.user ?? 'unknown'} (${auth.user_id ?? '?'}, ${auth.team ?? '?'})`;
  triggerPattern = new RegExp(`^@${escapeRegExp(config.triggerName)}\\b`, 'i');

  app = boltApp;
  try {
    await boltApp.start();
  } catch (err) {
    app = null;
    throw err;
  }

  logger.info({ tag: botTag, id: botUserId }, 'Slack bot connected');
}

async function handleMessage(event: InboundMessageEvent): Promise<void> {
  // Loop prevention: ignore anything authored by a bot (including ourselves
  // and cross-bot loops), and only process plain user messages / file shares.
  // Edits, deletions, joins, etc. arrive as other subtypes and are dropped.
  if ('bot_id' in event && event.bot_id) return;
  if (event.subtype === 'bot_message') return;
  if (event.subtype !== undefined && event.subtype !== 'file_share') return;
  if (!event.user || event.user === botUserId) return;

  const isDM = event.channel_type === 'im';
  const channelId = event.channel;
  const jid = `sl:${channelId}`;

  if (isDM && config.dmPolicy === 'disabled') {
    logger.debug({ jid }, 'DM policy is disabled, ignoring');
    return;
  }

  // ── Build content ──
  let content = event.text ?? '';
  const sender = event.user;
  const senderName = await resolveUserName(sender);
  const timestamp = slackTsToIso(event.ts);

  // Translate <@bot> mentions → trigger format
  if (botUserId && content.includes(`<@${botUserId}`)) {
    content = content.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), '').trim();
    if (!triggerPattern.test(content)) {
      content = `@${config.triggerName} ${content}`;
    }
  }

  // Attachments → extract metadata for downstream download (url_private
  // requires a Bearer header; session/media.ts injects it for slack.com hosts)
  let acceptedAttachments: AttachmentMeta[] = [];
  let attachmentsJson: string | null = null;
  const files = event.files ?? [];
  if (files.length > 0) {
    const metas: AttachmentMeta[] = files.flatMap((file) =>
      file.url_private
        ? [
            {
              url: file.url_private,
              name: file.name || 'file',
              contentType: file.mimetype || '',
              size: file.size || 0,
            },
          ]
        : [],
    );

    const selection = selectAttachmentsWithinLimits(metas, {
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
    });

    acceptedAttachments = selection.accepted;
    if (selection.rejected.length > 0) {
      logger.info(
        {
          jid,
          skipped: selection.rejected.map(({ attachment, reason, limitBytes }) => ({
            name: attachment.name,
            size: attachment.size,
            reason,
            limitBytes,
          })),
        },
        'Skipped oversized Slack attachments before enqueue',
      );
    }

    if (acceptedAttachments.length > 0) {
      attachmentsJson = JSON.stringify(acceptedAttachments);
    }
  }

  // ── Channel registration check ──
  let channel = getChannel(jid);

  // Auto-register DMs
  if (!channel && isDM && config.dmPolicy === 'open') {
    const reg = createDmChannel(jid, sender, senderName);
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, senderName }, 'Auto-registered DM channel');
  }

  // Auto-register channels/groups/mpims based on policy
  if (!channel && !isDM && config.channelPolicy !== 'allowlist') {
    if (config.excludedChannels.has(channelId)) {
      return;
    }

    const channelName = await resolveChannelName(channelId);
    const name = `${teamName || 'Workspace'} #${channelName}`;
    const reg: RegisteredChannel = {
      jid,
      name,
      folder: `ch_${channelId}`,
      requiresTrigger: config.channelPolicy === 'open-trigger',
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    };
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, name, policy: config.channelPolicy }, 'Auto-registered channel');
  }

  if (!channel) {
    logger.debug({ jid }, 'Message from unregistered channel, ignoring');
    return;
  }

  // ── Trigger check ──
  if (channel.requiresTrigger && !triggerPattern.test(content)) {
    logger.debug({ jid }, 'Message does not match trigger, ignoring');
    return;
  }

  // Strip trigger prefix from content sent to agent
  content = content.replace(triggerPattern, '').trim();
  if (!content && acceptedAttachments.length > 0) {
    content = buildAttachmentOnlyPrompt(acceptedAttachments.length);
  }
  if (!content) return;

  // ── Enqueue ──
  // Sessions stay channel-based (MVP), but the ts/thread_ts context rides
  // along so the response lands in the triggering message's thread.
  enqueueMessage({
    channelJid: jid,
    sender,
    senderName,
    content,
    timestamp,
    attachments: attachmentsJson,
    eventTs: event.ts,
    threadTs: event.thread_ts ?? null,
  });
  logger.info({ jid, sender: senderName, len: content.length }, 'Message enqueued');
}

// ── Outbound ──

const SLACK_MAX_LENGTH = 4000;
const SEND_INTERVAL_MS = 1000;

/** channelId → next allowed outbound send time (epoch ms) */
const nextSendAt = new Map<string, number>();

export async function sendResponse(
  jid: string,
  text: string,
  ctx?: { threadTs?: string },
): Promise<boolean> {
  if (!app) return false;
  const client = app.client;

  const channelId = jid.replace(/^sl:/, '');
  // Threading policy lives here: honor the triggering message's thread only
  // when REPLY_IN_THREAD is enabled; otherwise post top-level.
  const threadTs = config.replyInThread ? ctx?.threadTs : undefined;

  try {
    const chunks = text.length <= SLACK_MAX_LENGTH ? [text] : splitMessage(text, SLACK_MAX_LENGTH);
    for (const chunk of chunks) {
      await paceOutbound(channelId);
      // markdown_text takes standard Markdown, so no mrkdwn conversion needed.
      await client.chat.postMessage({
        channel: channelId,
        markdown_text: chunk,
        thread_ts: threadTs,
      });
    }
    logger.info({ jid, length: text.length }, 'Response sent');
    return true;
  } catch (err: any) {
    logger.error({ jid, err: err.message }, 'Failed to send message');
    return false;
  }
}

const BUSY_REACTION = 'hourglass_flowing_sand';

/**
 * Busy indicator: Slack has no bot typing indicator, so react to the
 * triggering message instead. No-ops when there is no message ts (scheduler
 * runs) and never rejects — a missing reactions:write scope must not break
 * the processing pipeline.
 */
export async function setBusy(jid: string, on: boolean, ctx?: { ts?: string }): Promise<void> {
  if (!app || !ctx?.ts) return;

  const channelId = jid.replace(/^sl:/, '');
  try {
    if (on) {
      await app.client.reactions.add({
        channel: channelId,
        timestamp: ctx.ts,
        name: BUSY_REACTION,
      });
    } else {
      await app.client.reactions.remove({
        channel: channelId,
        timestamp: ctx.ts,
        name: BUSY_REACTION,
      });
    }
  } catch (err: any) {
    logger.debug({ jid, err: err.message }, 'Busy reaction update failed');
  }
}

export function stopSlack(): void {
  if (!app) return;

  const stopping = app;
  app = null;
  botTag = undefined;
  void stopping.stop().catch((err: any) => {
    logger.debug({ err: err.message }, 'Slack app stop failed');
  });
  logger.info('Slack bot stopped');
}

export function getBotTag(): string | undefined {
  return botTag;
}

// ── Helpers ──

/** Resolve a user's display name via users.info, cached per user id. */
async function resolveUserName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  if (!app) return userId;

  try {
    const res = await app.client.users.info({ user: userId });
    const name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch (err: any) {
    // Missing users:read scope: fall back to the raw user id.
    logger.debug({ userId, err: err.message }, 'users.info lookup failed');
    return userId;
  }
}

/** Resolve a channel's name for registration labels; best-effort. */
async function resolveChannelName(channelId: string): Promise<string> {
  if (!app) return channelId;

  try {
    const res = await app.client.conversations.info({ channel: channelId });
    return res.channel?.name_normalized || res.channel?.name || channelId;
  } catch (err: any) {
    // Missing channels:read/groups:read scope: fall back to the raw id.
    logger.debug({ channelId, err: err.message }, 'conversations.info lookup failed');
    return channelId;
  }
}

/** Reserve the next outbound slot for a channel (~1 msg/s per channel). */
async function paceOutbound(channelId: string): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSendAt.get(channelId) ?? 0);
  nextSendAt.set(channelId, slot + SEND_INTERVAL_MS);

  const waitMs = slot - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Slack ts ("1712345678.123456") → ISO timestamp. */
function slackTsToIso(ts: string): string {
  const ms = Number.parseFloat(ts) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function splitMessage(text: string, max: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) splitAt = max; // hard split if no newline
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
