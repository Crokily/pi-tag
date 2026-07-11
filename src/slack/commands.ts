/**
 * /pi slash command.
 *
 * Slack has no per-command autocomplete or typed subcommands, so a single
 * global /pi command carries text subcommands:
 *   status | model <ref> | models | reset-model | thinking <level> | new | stop
 * Replies are ephemeral (respond() posts to the command's response_url).
 */

import type { App, RespondFn, SlashCommand } from '@slack/bolt';
import {
  getChannelSessionStatus,
  type ChannelSessionStatus,
  type SessionContextUsage,
  type SessionTokenUsage,
} from '../agent/invoke.js';
import { config } from '../config.js';
import {
  clearChannelModelOverride,
  clearPendingMessages,
  createDmChannel,
  getChannel,
  registerChannel,
  setChannelModelOverride,
  setChannelThinkingOverride,
} from '../db.js';
import { logger } from '../logger.js';
import {
  isThinkingLevel,
  listSelectableModels,
  resolveModelReference,
  resolveThinkingForModel,
  toModelChoiceName,
} from '../agent/model-catalog.js';
import {
  buildThinkingAdjustmentMessage,
  computeEffectiveChannelSettings,
  getDesiredThinkingLevel,
  type EffectiveChannelSettings,
} from '../agent/channel-settings.js';
import { abortChannelTask, isChannelProcessing } from '../agent/queue.js';
import { rotateChannelSessionDir } from '../session/path.js';
import { THINKING_LEVELS, type RegisteredChannel } from '../types.js';

export function registerCommands(app: App): void {
  app.command('/pi', async ({ command, ack, respond }) => {
    // Slash commands must be acked within 3s; respond() stays valid for 30min.
    await ack();

    const [rawSubcommand = '', ...args] = command.text.trim().split(/\s+/).filter(Boolean);
    const subcommand = rawSubcommand.toLowerCase();

    try {
      switch (subcommand) {
        case 'status':
          await handleStatus(command, respond);
          return;
        case 'model':
          await handleModelSet(command, respond, args.join(' '));
          return;
        case 'models':
          await handleModels(command, respond);
          return;
        case 'reset-model':
          await handleModelReset(command, respond);
          return;
        case 'thinking':
          await handleThinkingSet(command, respond, args[0] ?? '');
          return;
        case 'new':
          await handleNew(command, respond);
          return;
        case 'stop':
          await handleStop(command, respond);
          return;
        case '':
          await respond(usageMessage());
          return;
        default:
          await respond(`Unknown subcommand: ${subcommand}\n${usageMessage()}`);
      }
    } catch (err: any) {
      logger.error({ err: err.message, command: '/pi', subcommand }, 'Slash command failed');
      try {
        await respond(`⚠️ ${err.message}`);
      } catch {
        // response_url expired or unreachable; nothing else to do.
      }
    }
  });
  logger.info('Registered /pi slash command handler');
}

function usageMessage(): string {
  return [
    'Usage: `/pi <subcommand>`',
    '• `status` — show the current model and thinking configuration',
    '• `model <ref>` — set the default model for this channel',
    '• `models` — list the models pi can currently use',
    '• `reset-model` — reset this channel to the gateway default model',
    `• \`thinking <level>\` — set thinking level (${THINKING_LEVELS.join('|')})`,
    '• `new` — start a fresh pi session for this channel',
    '• `stop` — abort the current task and clear the queue',
  ].join('\n');
}

async function handleNew(command: SlashCommand, respond: RespondFn): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  if (isChannelProcessing(channel.jid)) {
    await respond(
      'This channel is currently processing a message. Wait for it to finish, then run `/pi new` again.',
    );
    return;
  }

  const cleared = clearPendingMessages(channel.jid);
  const archivedSession = rotateChannelSessionDir(channel.folder);

  logger.info(
    { jid: channel.jid, cleared, archived: Boolean(archivedSession) },
    'Channel session reset',
  );

  const notes = ['Started a fresh session for this channel.'];
  if (cleared > 0) {
    notes.push(`Cleared ${cleared} queued ${cleared === 1 ? 'message' : 'messages'}.`);
  }
  if (archivedSession) {
    notes.push('Archived the previous session on disk.');
  }

  await respond(notes.join('\n'));
}

async function handleStop(command: SlashCommand, respond: RespondFn): Promise<void> {
  const jid = `sl:${command.channel_id}`;
  const result = abortChannelTask(jid);

  if (!result.aborted && result.cleared === 0) {
    await respond('No active task or queued messages in this channel.');
    return;
  }

  const notes: string[] = [];
  if (result.aborted) {
    notes.push('Aborted the current task.');
  }
  if (result.cleared > 0) {
    notes.push(
      `Cleared ${result.cleared} queued ${result.cleared === 1 ? 'message' : 'messages'}.`,
    );
  }

  await respond(notes.join(' '));
}

async function handleStatus(command: SlashCommand, respond: RespondFn): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  const effective = computeEffectiveChannelSettings(channel);
  const sessionStatus = await getChannelSessionStatus(channel.folder, effective.effectiveCwd);
  await respond(buildStatusMessage(effective, sessionStatus));
}

async function handleModels(command: SlashCommand, respond: RespondFn): Promise<void> {
  // Model availability can depend on the channel's working dir override.
  const channel = getChannel(`sl:${command.channel_id}`);
  const cwd = channel?.cwdOverride || config.piCwd;
  const models = await listSelectableModels({ cwd });

  if (models.length === 0) {
    await respond('No models available. Check pi authentication and PI_BIN on the gateway host.');
    return;
  }

  await respond(formatModelList(models.map(toModelChoiceName)));
}

async function handleModelSet(
  command: SlashCommand,
  respond: RespondFn,
  selectedRef: string,
): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  if (!selectedRef) {
    await respond('Usage: `/pi model <ref>` — run `/pi models` to list available models.');
    return;
  }

  const cwd = channel.cwdOverride || config.piCwd;
  const models = await listSelectableModels({ forceRefresh: true, cwd });
  const selectedModel = resolveModelReference(selectedRef, models);
  if (!selectedModel) {
    await respond(
      `No available model matches: ${selectedRef}. Run \`/pi models\` to list available models.`,
    );
    return;
  }

  setChannelModelOverride(channel.jid, selectedModel.ref);

  // Re-read channel to use the persisted override in status/effective computation.
  const updated = getChannel(channel.jid)!;
  const desiredThinking = getDesiredThinkingLevel(updated);
  const thinkingResolution = resolveThinkingForModel(selectedModel, desiredThinking);

  // Only persist the clamped value if the channel already had an explicit thinking override.
  if (updated.thinkingOverride) {
    setChannelThinkingOverride(updated.jid, thinkingResolution.effective);
  }

  const notes = [`Model set to ${selectedModel.ref} for this channel.`];
  if (thinkingResolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        thinkingResolution.requested,
        thinkingResolution.effective,
        selectedModel,
      ),
    );
  }

  await respond(notes.join('\n'));
}

async function handleModelReset(command: SlashCommand, respond: RespondFn): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  clearChannelModelOverride(channel.jid);

  const updated = getChannel(channel.jid)!;
  const effective = computeEffectiveChannelSettings(updated, { forceRefresh: true });
  const notes = ['Model reset for this channel.'];

  if (updated.thinkingOverride && effective.thinkingAdjusted) {
    setChannelThinkingOverride(updated.jid, effective.effectiveThinking);
  }

  if (effective.thinkingAdjusted) {
    const currentThinking = effective.hasManagedThinking
      ? effective.effectiveThinking
      : '(pi runtime default)';
    notes.push(
      `Current effective thinking is ${currentThinking}. ${effective.thinkingAdjustmentMessage}`,
    );
  }

  await respond(notes.join('\n'));
}

async function handleThinkingSet(
  command: SlashCommand,
  respond: RespondFn,
  rawLevel: string,
): Promise<void> {
  const channel = ensureManagedChannel(command);
  if (!channel) {
    await respond(notRegisteredMessage());
    return;
  }

  const level = rawLevel.toLowerCase();
  if (!isThinkingLevel(level)) {
    await respond(
      `Invalid thinking level: ${rawLevel || '(none)'}. Valid levels: ${THINKING_LEVELS.join(', ')}.`,
    );
    return;
  }

  const effective = computeEffectiveChannelSettings(channel, { forceRefresh: true });
  const resolution = resolveThinkingForModel(effective.modelInfo, level);

  setChannelThinkingOverride(channel.jid, resolution.effective);

  const notes = [`Thinking level set to ${resolution.effective} for this channel.`];
  if (resolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        resolution.requested,
        resolution.effective,
        effective.modelInfo,
      ),
    );
  }

  await respond(notes.join('\n'));
}

function ensureManagedChannel(command: SlashCommand): RegisteredChannel | undefined {
  const jid = `sl:${command.channel_id}`;
  const channel = getChannel(jid);
  if (channel) return channel;

  // Allow slash commands to bootstrap DM channels, same as normal DM messages.
  if (command.channel_id.startsWith('D') && config.dmPolicy === 'open') {
    const reg = createDmChannel(jid, command.user_id, command.user_name);
    registerChannel(reg);
    return getChannel(jid) ?? reg;
  }

  return undefined;
}

function notRegisteredMessage(): string {
  return 'This channel is not registered yet. Send a regular message in this channel first — the gateway will auto-register it (if channel policy is `open` or `open-trigger`).';
}

function formatModelList(lines: string[]): string {
  // Keep the ephemeral reply within one Slack message (~4k chars).
  const maxBodyLength = 3500;
  let body = '';
  let shown = 0;
  for (const line of lines) {
    if (body.length + line.length + 1 > maxBodyLength) break;
    body += `${line}\n`;
    shown += 1;
  }

  const parts = [
    `Available models (${lines.length}) — set one with \`/pi model <ref>\`:`,
    `\`\`\`text\n${body.trimEnd()}\n\`\`\``,
  ];
  if (shown < lines.length) {
    parts.push(`…and ${lines.length - shown} more. \`/pi model <ref>\` matches fuzzily.`);
  }
  return parts.join('\n');
}

function buildStatusMessage(
  effective: EffectiveChannelSettings,
  sessionStatus: ChannelSessionStatus,
): string {
  const rows: Array<[string, string]> = [
    ['Model', formatModelValue(effective)],
    ['Thinking', formatThinkingValue(effective)],
    ['Working dir', formatWorkingDirValue(effective)],
  ];

  if (effective.thinkingAdjusted) {
    rows.push(['Fallback', formatThinkingFallback(effective)]);
  }

  rows.push(
    ['Reasoning', effective.modelInfo ? (effective.modelInfo.reasoning ? 'yes' : 'no') : 'unknown'],
    [
      'Session',
      sessionStatus.createdAt ? formatSessionCreatedAt(sessionStatus.createdAt) : 'not started',
    ],
    ['Tokens', formatTokenUsage(sessionStatus.tokens, sessionStatus.statsSource)],
    ['Context', formatContextUsage(sessionStatus.contextUsage)],
  );

  return `\`\`\`text\n${formatTwoColumnRows(rows)}\n\`\`\``;
}

function formatModelValue(effective: EffectiveChannelSettings): string {
  if (effective.modelSource === 'pi runtime default') {
    return 'pi runtime default';
  }

  return `${effective.displayModel} (${formatSettingSource(effective.modelSource)})`;
}

function formatThinkingValue(effective: EffectiveChannelSettings): string {
  if (!effective.hasManagedThinking || effective.thinkingSource === 'pi runtime default') {
    return 'pi runtime default';
  }

  return `${effective.effectiveThinking} (${formatSettingSource(effective.thinkingSource)})`;
}

function formatThinkingFallback(effective: EffectiveChannelSettings): string {
  if (
    effective.modelInfo &&
    !effective.modelInfo.reasoning &&
    effective.requestedThinking !== 'off'
  ) {
    return `${effective.requestedThinking} -> off (no reasoning)`;
  }

  if (effective.requestedThinking === 'xhigh' && effective.effectiveThinking === 'high') {
    return 'xhigh -> high (unsupported)';
  }

  return `${effective.requestedThinking} -> ${effective.effectiveThinking}`;
}

function formatWorkingDirValue(effective: EffectiveChannelSettings): string {
  return `${effective.effectiveCwd} (${effective.cwdSource === 'override' ? 'channel' : 'gateway'})`;
}

function formatSettingSource(source: EffectiveChannelSettings['modelSource']): string {
  switch (source) {
    case 'override':
      return 'channel';
    case 'default':
      return 'gateway';
    case 'pi runtime default':
      return 'pi';
  }
}

function formatSessionCreatedAt(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function formatTokenUsage(
  tokens: SessionTokenUsage | undefined,
  statsSource: ChannelSessionStatus['statsSource'],
): string {
  if (!tokens) {
    return statsSource === 'none' ? '0 total' : '?';
  }

  const cache = tokens.cacheRead + tokens.cacheWrite;
  const details = [`${formatNumber(tokens.input)} in`, `${formatNumber(tokens.output)} out`];
  if (cache > 0) {
    details.push(`${formatNumber(cache)} cache`);
  }

  const showDetails = tokens.input > 0 || tokens.output > 0 || cache > 0;
  return `${formatNumber(tokens.total)} total${showDetails ? ` (${details.join(' / ')})` : ''}`;
}

function formatContextUsage(contextUsage: SessionContextUsage | undefined): string {
  if (!contextUsage) {
    return '?';
  }

  const tokens = contextUsage.tokens == null ? '?' : formatNumber(contextUsage.tokens);
  const window =
    contextUsage.contextWindow == null ? '?' : formatNumber(contextUsage.contextWindow);
  const percent = contextUsage.percent == null ? '?' : `${formatPercent(contextUsage.percent)}%`;
  return `${tokens} / ${window} (${percent})`;
}

function formatTwoColumnRows(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}
