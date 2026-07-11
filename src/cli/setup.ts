import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import * as clack from '@clack/prompts';
import { listAvailableModels } from '../agent/model-catalog.js';
import type { DmPolicy } from '../config.js';
import { defaultDataDir, resolveConfigPath, validateSlackTokens } from '../config.js';

const SERVICE_NAME = 'pitag';
const DEFAULT_TRIGGER_NAME = 'pi';
const DEFAULT_WORKING_DIR = homedir();
const DEFAULT_DATA_DIR = defaultDataDir();
const DEFAULT_SESSIONS_DIR = resolve(DEFAULT_DATA_DIR, 'sessions');
const DEFAULT_DB_PATH = resolve(DEFAULT_DATA_DIR, 'gateway.db');
const AUTH_PATH = resolve(homedir(), '.pi/agent/auth.json');

export async function runSetup(args: string[]): Promise<void> {
  const botTokenArg = args[0]?.trim() ?? '';
  const appTokenArg = args[1]?.trim() ?? '';
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const configPath = resolveConfigPath();

  if (!interactive && (!botTokenArg || !appTokenArg)) {
    throw new Error(
      'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be provided as arguments when stdin is not interactive.',
    );
  }

  clack.intro('pitag setup');

  // ── Prerequisites ──
  const prereqs = checkPrerequisites();
  const prereqLines = [
    prereqs.piPath
      ? `  ✓ pi binary: ${prereqs.piPath}${prereqs.piVersion ? ` (${prereqs.piVersion})` : ''}`
      : '  ✗ pi binary: not found in PATH — install pi first',
    prereqs.authFound ? `  ✓ pi auth: found` : `  ✗ pi auth: missing — run "pi" and log in first`,
    prereqs.modelCount !== undefined
      ? `  ✓ models: ${prereqs.modelCount} available`
      : `  ✗ models: unavailable`,
  ];
  clack.note(prereqLines.join('\n'), 'Prerequisites');

  if (!prereqs.piPath || !prereqs.authFound) {
    clack.log.warn(
      'Some prerequisites are missing. The gateway needs pi installed and logged in to work.',
    );
  }

  // ── Slack app creation ──
  if (interactive && (!botTokenArg || !appTokenArg)) {
    clack.note(
      [
        '1. Open https://api.slack.com/apps and click "Create New App"',
        '2. Choose "From a manifest", pick your workspace, and paste the',
        '   contents of manifest.yaml from this repository',
        '   (Socket Mode, scopes, and the /pi command are preconfigured)',
        '3. Click "Install to Workspace" and approve the permissions',
        '4. OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…)',
        '5. Basic Information → App-Level Tokens → generate a token with',
        '   the connections:write scope and copy it (xapp-…)',
      ].join('\n'),
      'Create your Slack app',
    );
  }

  // ── Bot token ──
  let botToken = botTokenArg;
  if (!botToken && interactive) {
    const result = await clack.text({
      message: 'Slack Bot Token (xoxb-…)',
      placeholder: 'Paste your bot token here',
      validate: (v) => {
        if (!v.trim()) return 'Token cannot be empty.';
        if (!v.trim().startsWith('xoxb-')) return 'Bot tokens start with "xoxb-".';
      },
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    botToken = result.trim();
  }

  // ── App-level token (Socket Mode) ──
  let appToken = appTokenArg;
  if (!appToken && interactive) {
    const result = await clack.text({
      message: 'Slack App-Level Token (xapp-…, Socket Mode)',
      placeholder: 'Paste your app-level token here',
      validate: (v) => {
        if (!v.trim()) return 'Token cannot be empty.';
        if (!v.trim().startsWith('xapp-')) return 'App-level tokens start with "xapp-".';
      },
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    appToken = result.trim();
  }

  // Covers non-interactive/argument-passed tokens too (same rules as startup).
  const tokenProblems = validateSlackTokens({ slackBotToken: botToken, slackAppToken: appToken });
  if (tokenProblems.length > 0) {
    throw new Error(tokenProblems.join(' '));
  }

  // ── Trigger name ──
  let triggerName = DEFAULT_TRIGGER_NAME;
  if (interactive) {
    const result = await clack.text({
      message: 'Trigger Name',
      placeholder: DEFAULT_TRIGGER_NAME,
      defaultValue: DEFAULT_TRIGGER_NAME,
      initialValue: DEFAULT_TRIGGER_NAME,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    triggerName = result || DEFAULT_TRIGGER_NAME;
  }

  // ── Channel policy ──
  let channelPolicy: 'open' | 'open-trigger' | 'allowlist' = 'allowlist';
  if (interactive) {
    const result = await clack.select({
      message: 'Channel Policy — how should the bot handle workspace channels?',
      options: [
        {
          value: 'open' as const,
          label: 'open',
          hint: 'Respond to all messages in every channel the bot is a member of',
        },
        {
          value: 'open-trigger' as const,
          label: 'open-trigger',
          hint: `Listen in all channels, but only respond when @${triggerName} is mentioned`,
        },
        {
          value: 'allowlist' as const,
          label: 'allowlist',
          hint: 'Only respond in manually registered channels (pitag register ...)',
        },
      ],
      initialValue: 'allowlist' as const,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    channelPolicy = result;
  }

  // ── DM policy ──
  let dmPolicy: DmPolicy = 'open';
  if (interactive) {
    const result = await clack.select({
      message: 'DM Policy — how should the bot handle direct messages?',
      options: [
        {
          value: 'open' as const,
          label: 'open',
          hint: 'Respond to all DMs, registering them automatically',
        },
        {
          value: 'allowlist' as const,
          label: 'allowlist',
          hint: 'Only respond in manually registered DM channels (IDs start with D)',
        },
        {
          value: 'disabled' as const,
          label: 'disabled',
          hint: 'Ignore all direct messages',
        },
      ],
      initialValue: 'open' as const,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    dmPolicy = result;
  }

  // ── Reply in thread ──
  let replyInThread = true;
  if (interactive) {
    const result = await clack.confirm({
      message: 'Reply in thread — when a message lives in a thread, answer inside it?',
      initialValue: true,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    replyInThread = result;
  }

  // ── Working directory ──
  let workingDir = DEFAULT_WORKING_DIR;
  if (interactive) {
    const result = await clack.text({
      message: 'Working Directory — base directory pi uses when executing commands',
      placeholder: DEFAULT_WORKING_DIR,
      defaultValue: DEFAULT_WORKING_DIR,
      initialValue: DEFAULT_WORKING_DIR,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    workingDir = result || DEFAULT_WORKING_DIR;
  }

  // ── Write config ──
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  mkdirSync(DEFAULT_SESSIONS_DIR, { recursive: true });

  writeFileSync(
    configPath,
    buildConfigFile({
      botToken,
      appToken,
      triggerName,
      workingDir,
      channelPolicy,
      dmPolicy,
      replyInThread,
      sessionsDir: DEFAULT_SESSIONS_DIR,
      dbPath: DEFAULT_DB_PATH,
    }),
  );

  clack.log.success(`Config written to: ${configPath}`);

  // ── Daemon install + start ──
  if (interactive && isUnix()) {
    const serviceName = process.platform === 'darwin' ? 'launchd' : 'systemd';
    const installDaemon = await clack.confirm({
      message: `Install as a background service (${serviceName}) and start now?`,
      initialValue: true,
    });
    if (clack.isCancel(installDaemon)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }

    if (installDaemon) {
      const s = clack.spinner();
      s.start(`Installing ${serviceName} service...`);
      try {
        const { runDaemon } = await import('./daemon.js');
        runDaemon('install');
        s.message('Starting service...');
        runDaemon('start');
        s.stop('Service installed and started.');
        clack.log.success(`${SERVICE_NAME} is active`);
      } catch (err) {
        s.stop('Service installation failed.');
        clack.log.error(errorMessage(err));
        clack.log.info(
          'You can install manually later: pitag daemon install && pitag daemon start',
        );
      }
    }
  }

  // ── Summary ──
  const summaryLines = [
    `Config:    ${configPath}`,
    `Policy:    ${channelPolicy}`,
    `DMs:       ${dmPolicy}`,
    `Threads:   ${replyInThread ? 'reply in thread' : 'reply top-level'}`,
    `Trigger:   ${triggerName}`,
    `Sessions:  ${DEFAULT_SESSIONS_DIR}`,
  ];
  clack.note(summaryLines.join('\n'), 'Configuration');

  clack.outro('Setup complete! Invite the bot to a Slack channel (/invite) or DM it to test.');
}

function checkPrerequisites(): {
  piPath: string | undefined;
  piVersion: string | undefined;
  authFound: boolean;
  modelCount: number | undefined;
} {
  const piPath = findExecutable('pi');
  const piVersion = piPath ? readCommandOutput('pi --version') : undefined;
  const authFound = existsSync(AUTH_PATH);
  let modelCount: number | undefined;

  try {
    modelCount = listAvailableModels().length;
  } catch {
    modelCount = undefined;
  }

  return { piPath, piVersion, authFound, modelCount };
}

function findExecutable(name: string): string | undefined {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return readCommandOutput(`${cmd} ${name}`);
}

function isUnix(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin';
}

export function buildConfigFile(options: {
  botToken: string;
  appToken: string;
  triggerName: string;
  workingDir: string;
  channelPolicy?: 'open' | 'open-trigger' | 'allowlist';
  dmPolicy?: DmPolicy;
  replyInThread?: boolean;
  sessionsDir: string;
  dbPath: string;
}): string {
  return [
    '# Generated by: pitag setup',
    '# Or edit manually. See: pitag help',
    '',
    `SLACK_BOT_TOKEN=${options.botToken}`,
    `SLACK_APP_TOKEN=${options.appToken}`,
    '',
    '# Pi agent configuration',
    'PI_BIN=pi',
    'PI_MODEL=',
    'PI_THINKING=',
    `PI_CWD=${options.workingDir}`,
    'PI_EXTRA_FLAGS=',
    '',
    '# Gateway behavior',
    `TRIGGER_NAME=${options.triggerName}`,
    'MAX_CONCURRENCY=3',
    'MAX_SCHEDULED_CONCURRENCY=1',
    'POLL_INTERVAL_MS=1000',
    'SHUTDOWN_TIMEOUT_MS=15000',
    `DM_POLICY=${options.dmPolicy ?? 'open'}`,
    `REPLY_IN_THREAD=${options.replyInThread ?? true}`,
    `CHANNEL_POLICY=${options.channelPolicy ?? 'allowlist'}`,
    'EXCLUDED_CHANNELS=',
    'MAX_ATTACHMENT_BYTES=26214400',
    'MAX_TOTAL_ATTACHMENT_BYTES=52428800',
    'MEDIA_RETENTION_HOURS=168',
    '',
    '# Archive',
    'ARCHIVE_RETENTION_DAYS=30',
    '',
    '# Storage',
    `SESSIONS_DIR=${options.sessionsDir}`,
    `DB_PATH=${options.dbPath}`,
    '',
    '# Logging',
    'LOG_LEVEL=info',
    '',
  ].join('\n');
}

function readCommandOutput(command: string): string | undefined {
  try {
    const stdout = execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (stdout) return stdout;
  } catch {}
  // Some commands (e.g. pi --version) output to stderr — retry with merge
  try {
    return (
      execSync(command + ' 2>&1', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
