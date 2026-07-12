<h1 align="center">pi-tag</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-tag"><img src="https://img.shields.io/npm/v/pi-tag?cacheSeconds=3600" alt="npm version"></a>
  <img src="https://img.shields.io/npm/l/pi-tag?cacheSeconds=3600" alt="license">
  <img src="https://img.shields.io/node/v/pi-tag?cacheSeconds=3600" alt="node version">
  <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-blue" alt="platform">
</p>

pi-tag puts the [pi coding agent](https://github.com/badlogic/pi-mono) in Slack. Chat with pi in DMs, channels, and threads — from your desktop or your phone. Each channel is its own persistent session with its own working directory and model; pi reads the files you drop into Slack and sends files back; recurring tasks run on a schedule; an interactive `/pi` panel switches models and thinking levels with a click.

```bash
npm install -g pi-tag
pitag setup        # interactive wizard — walks you through everything
```

The wizard checks prerequisites, walks you through creating the Slack app, asks for your two tokens, lets you pick an access policy, and optionally installs a background service. (No global install? `npx pi-tag@latest setup` works too. Both `pitag` and `pi-tag` commands are installed.)

## Requirements

- **Node.js** ≥ 22.19
- **[pi](https://github.com/badlogic/pi-mono)** ≥ 0.80 on `PATH`, with login completed (`~/.pi/agent/auth.json`) — pi-tag runs on the same machine as pi and drives your existing install
- **A Slack workspace** where you can create apps (free plan is fine)
- Linux, macOS, or Windows

## Quick Start

1. **Create the Slack app** — [api.slack.com/apps](https://api.slack.com/apps) → _Create New App_ → _From a manifest_ → pick your workspace → paste [`manifest.yaml`](./manifest.yaml) from this repository.
2. **Install it to your workspace** — _OAuth & Permissions_ → _Install to Workspace_, copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Create the app-level token** — _Basic Information_ → _App-Level Tokens_ → generate one with the `connections:write` scope, copy it (`xapp-…`).
4. **Run `pitag setup`** and paste both tokens.
5. **Talk** — open a DM with the bot, or `/invite @pi` to a channel and register it (see [Access control](#access-control)).

The app uses Socket Mode: the gateway opens an outbound WebSocket, so no public URL or inbound ports are needed.

## Talking to pi

- **DMs** — every message reaches pi (default `DM_POLICY=open`). Great from the Slack mobile app: kick off a task from your phone, get the result when it's done.
- **Channels** — register a channel and pi joins the conversation. In trigger-gated channels, summon it by @mentioning the bot or starting your message with its trigger name: `@pi fix the build` and `pi fix the build` both work (`TRIGGER_NAME`, matched only at the start of a message).
- **Threads** — trigger pi inside a thread and the answer lands in that thread (`REPLY_IN_THREAD=true` by default). Threads share the channel's session; they're a reply location, not a separate conversation.
- While pi works, your message gets an hourglass reaction; long answers are posted as Markdown and split at Slack's 4,000-character limit.
- Summoning the bot in an unregistered channel gets a short registration hint instead of silence (rate-limited to once per 10 minutes per channel).

## The `/pi` panel

A bare `/pi` opens an interactive control panel (ephemeral — only you see it): session status at a glance, model and thinking-level dropdowns picked straight from pi's catalog, and New session / Stop buttons with confirmation. No subcommands or model refs to remember.

Text subcommands still work for muscle memory:

| Subcommand          | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `/pi`               | Open the interactive panel                                         |
| `/pi help`          | Show text usage                                                    |
| `/pi status`        | Show model, thinking, working directory, session info, token usage |
| `/pi model <ref>`   | Set the channel's model (fuzzy-matched against pi's catalog)       |
| `/pi models`        | List the models pi can currently use                               |
| `/pi reset-model`   | Clear the channel's model override                                 |
| `/pi thinking <lv>` | Set thinking level: off / minimal / low / medium / high / xhigh    |
| `/pi new`           | Start a fresh session for this channel                             |
| `/pi stop`          | Abort the current task and clear queued messages                   |

The model list comes from your installed pi and honors its `enabledModels` scope, so it stays in sync as pi adds or removes models.

## Files, both directions

- **To pi** — drop a file into the chat. The gateway downloads it and hands it to pi by local path, so pi can inspect, convert, or edit any file type without flooding its context.
- **From pi** — ask for a file and pi delivers it: it's taught the gateway's `pitag send` command with every message, and any `file://` reference left in a reply is automatically uploaded as a real Slack attachment. Up to 10 files per message, subject to the configured size limits.

## Scheduled tasks

Tell pi what you want, in plain language:

> _"Create a daily task at 9am UTC that generates a summary report"_
> _"Set a one-time reminder for the 2pm meeting today"_

pi runs `pitag task add` behind the scenes — 5-field cron for recurring tasks, an ISO 8601 datetime with `--once` for one-shots. Scheduled prompts go through the normal message queue, so they use the channel's model, thinking level, and working directory. Manage tasks the same way (`pitag task list | enable | disable | remove`), by asking pi or from your terminal.

## Sessions

- **One session per channel.** Each registered channel or DM maps to its own pi session; history persists across messages via `pi --continue`.
- **Per-channel setup.** Point a channel at a project with `pitag register <id> <name> --cwd /path/to/repo`, and give it its own model and thinking level via `/pi` — overrides stick to the channel.
- **`/pi new` rotates the session** — the old one is archived and cleaned up after `ARCHIVE_RETENTION_DAYS`.

## Access control

Whoever can message the bot drives a coding agent with shell and filesystem access on the gateway machine — treat channel access accordingly. Two policies control who gets through:

**Channels** (`CHANNEL_POLICY`):

| Policy         | Behavior                                                         |
| -------------- | ---------------------------------------------------------------- |
| `allowlist`    | Only manually registered channels are active. **(default)**      |
| `open`         | Channels auto-register on first message. No @mention needed.     |
| `open-trigger` | Channels auto-register, but the bot only responds when summoned. |

**DMs** (`DM_POLICY`, independent of the channel policy):

| Policy      | Behavior                                                  |
| ----------- | --------------------------------------------------------- |
| `open`      | DM channels auto-register on first message. **(default)** |
| `allowlist` | Only DMs registered via `pitag register` get responses.   |
| `disabled`  | All DMs are ignored.                                      |

- Slack only delivers channel messages after the bot is **invited** (`/invite @pi`), so even `open` mode is gated by the invite.
- Register channels by **channel ID** (`C…` public, `G…` private, `D…` DM — bottom of the channel's _About_ tab), not `#name`:

  ```bash
  pitag register C0123456789 "team #general" --no-trigger
  pitag register C0123456789 "team #general" --cwd /srv/repos/app
  ```

- Group DMs (mpim) behave like channels and follow `CHANNEL_POLICY`.
- `EXCLUDED_CHANNELS` blocks specific channel IDs from auto-registration in `open` / `open-trigger` mode.

## How It Works

```
Slack ──Socket Mode (@slack/bolt)──→ Gateway ──pi subprocess──→ Pi Agent
                                        │                          │
                                      SQLite                  Session dirs
                                   (message queue)           (per channel)
```

The gateway runs on the machine where pi is installed and **does not embed or replace `pi`** — it shells out to your binary (`PI_BIN` or `PATH`), which reuses your own login and model access. Each message runs as `pi --session-dir <dir> --continue -p <message>`.

Every received Slack event is acknowledged immediately and written to the SQLite queue before processing, so a crash or restart never loses an accepted message. Channels are processed serially; global parallelism is capped by `MAX_CONCURRENCY`.

## Running as a Daemon

The setup wizard offers to install a background service; you can also manage it manually:

```bash
pitag daemon install | start | status | logs | stop | uninstall
```

- **Linux** — systemd user service (`pitag`). Headless server? Enable lingering: `sudo loginctl enable-linger $USER`
- **macOS** — launchd user agent (`com.pitag`)
- **Windows** — no daemon management yet; run `pitag start` in a terminal or use Task Scheduler

Run **exactly one** gateway instance per Slack app — Socket Mode load-balances events across connections, so a second instance silently takes half your messages.

## Configuration

`pitag setup` generates the config file for you; `pitag status` shows its path (Linux: `~/.config/pitag/config.env`, macOS: `~/Library/Application Support/pitag/config.env`, Windows: `%APPDATA%\pitag\config.env`). The `PITAG_CONFIG` environment variable overrides the location. After changes, restart: `pitag daemon stop && pitag daemon start`.

| Variable                     | Default                         | Description                                                                |
| ---------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`            | _(required)_                    | Bot User OAuth Token (`xoxb-…`)                                            |
| `SLACK_APP_TOKEN`            | _(required)_                    | App-level token with `connections:write` for Socket Mode (`xapp-…`)        |
| `PI_BIN`                     | `pi`                            | Path to pi binary                                                          |
| `PI_MODEL`                   | _(none)_                        | Default model override                                                     |
| `PI_THINKING`                | _(none)_                        | Default thinking level                                                     |
| `PI_CWD`                     | `$HOME`                         | Default working directory for pi; can be overridden per registered channel |
| `PI_EXTRA_FLAGS`             | _(none)_                        | Extra flags passed to pi                                                   |
| `TRIGGER_NAME`               | `pi`                            | Bot trigger name for summoning in channels                                 |
| `CHANNEL_POLICY`             | `allowlist`                     | Channel access: `open`, `open-trigger`, or `allowlist`                     |
| `EXCLUDED_CHANNELS`          | _(none)_                        | Comma-separated channel IDs to exclude from auto-registration              |
| `DM_POLICY`                  | `open`                          | DM access: `open`, `allowlist`, or `disabled`                              |
| `REPLY_IN_THREAD`            | `true`                          | Post responses into the triggering message's thread when it has one        |
| `MAX_CONCURRENCY`            | `3`                             | Max parallel pi invocations                                                |
| `MAX_SCHEDULED_CONCURRENCY`  | `1`                             | Max scheduled tasks enqueued per tick                                      |
| `POLL_INTERVAL_MS`           | `1000`                          | Queue poll interval (ms)                                                   |
| `SHUTDOWN_TIMEOUT_MS`        | `15000`                         | Graceful shutdown timeout (ms)                                             |
| `ARCHIVE_RETENTION_DAYS`     | `30`                            | Days to keep archived sessions (0 = never clean)                           |
| `MAX_ATTACHMENT_BYTES`       | `26214400`                      | Max size per attachment (0 = no limit)                                     |
| `MAX_TOTAL_ATTACHMENT_BYTES` | `52428800`                      | Max combined attachment size per message (0 = no limit)                    |
| `MEDIA_RETENTION_HOURS`      | `168`                           | Hours to keep downloaded attachment files for path-based agent access      |
| `SESSIONS_DIR`               | _(platform default)_/sessions   | Session storage directory                                                  |
| `DB_PATH`                    | _(platform default)_/gateway.db | SQLite database path                                                       |
| `LOG_LEVEL`                  | `info`                          | Log level: debug/info/warn/error                                           |

Data lives next to the config: `~/.local/share/pitag/` on Linux, `~/Library/Application Support/pitag/` on macOS, `%LOCALAPPDATA%\pitag\` on Windows.

## CLI Reference

```
pitag setup [bot-token] [app-token]           Interactive setup wizard
pitag start                                   Start gateway (foreground)
pitag status                                  Show diagnostics

pitag channels                                List registered channels
pitag register <id> <name> [options]          Register a channel
pitag unregister <id>                         Unregister a channel

pitag send --channel <jid> [--text <msg>] [--file <path> ...]

pitag task add --name <n> --schedule <cron|iso> --channel <jid> --prompt <text> [--once]
pitag task list | remove <id> | enable <id> | disable <id>

pitag archive list                            List archived sessions
pitag archive cleanup [--dry-run]             Clean up expired archived sessions

pitag daemon install | uninstall | start | stop | status | logs
```

Channel jids are the Slack channel ID with an `sl:` prefix (e.g. `sl:C0123456789`); bare IDs are accepted and prefixed automatically. Register options: `--no-trigger` (respond to all messages), `--main` (implies `--no-trigger`), `--folder <name>` (custom session folder), `--cwd <path>` (per-channel working directory).

`pitag send` and `pitag task` are also the gateway's tools for pi — pi invokes them itself when you ask it to send a file or schedule something. `pitag send` works standalone, without a running gateway.

## Troubleshooting

<details>
<summary><strong>pi not found in PATH</strong></summary>

`pitag status` shows "Pi binary: not found".

- Check `pi --version` works in the same shell
- Set `PI_BIN=/full/path/to/pi` in config.env
- Restart: `pitag daemon stop && pitag daemon start`
</details>

<details>
<summary><strong>Missing auth.json</strong></summary>

`pitag status` shows "Pi auth: missing".

- Run `pi` and complete the login flow
- Confirm `~/.pi/agent/auth.json` exists for the same user running the gateway
</details>

<details>
<summary><strong>Daemon service won't start</strong></summary>

- `pitag daemon status` — check for errors
- `pitag daemon logs` — see log output
- **Linux**: for headless servers, run `sudo loginctl enable-linger $USER`
- **macOS**: check `daemon.stdout.log` / `daemon.stderr.log` in the data directory
</details>

<details>
<summary><strong>Bot is online but doesn't respond</strong></summary>

- The bot must be **invited** to a channel before Slack delivers its messages: `/invite @pi`
- `allowlist` policy (the default): run `pitag channels` — the channel must be registered by its ID
- `open` policy: check `EXCLUDED_CHANNELS` doesn't include your channel
- For trigger-only channels: mention the bot (`@pi …`) or start the message with the trigger name
- DMs: check `DM_POLICY` isn't `disabled`
- Verify both tokens with `pitag status` (`xoxb-…` bot token and `xapp-…` app token)
</details>

<details>
<summary><strong>Replies are intermittent or sessions lose context</strong></summary>

Almost always caused by **two gateway instances running against the same app**. Slack Socket Mode load-balances events across connections, so a second instance silently receives half your messages and splits your sessions. Stop all copies (`pitag daemon stop`, check stray `pitag start` terminals) and run exactly one.

</details>

## Security

- **Access to the bot is access to the machine.** Anyone who can message a registered channel drives a coding agent with shell and filesystem rights of the gateway user — treat it like SSH access. The defaults are conservative (`CHANNEL_POLICY=allowlist`); widen them only for channels and people you trust, and consider `DM_POLICY=allowlist` or `disabled` in shared workspaces.
- **Assume prompt injection.** Everything in a registered channel reaches pi's context — other people's messages, attachment contents, pasted text — and pi may follow instructions embedded in it. Prefer trigger-gated channels; don't register busy public ones.
- **Run one instance, as a normal user.** Never run two gateways against the same Slack app (see Troubleshooting), and don't run the service as root.
- **Protect `config.env`** (`chmod 600`) — it holds both Slack tokens. The `xoxb-` token can read shared files and post as the bot in every channel it has joined.

The bundled manifest requests the minimal scope set the gateway uses (message events for channels/groups/DMs, `chat:write`, files read/write, `reactions:write`, `users:read`, conversation-read scopes for channel labels, `commands`). The gateway never pulls channel history — it only sees events Slack pushes to it.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Development

```bash
git clone https://github.com/Crokily/pi-tag.git
cd pi-tag
npm install
npm run dev          # Start with tsx (no build needed)
npm run build        # Compile TypeScript
npm test             # Run Vitest suite
```

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Release notes live in the [Changelog](./CHANGELOG.md).

## License

MIT

## Acknowledgments

- Forked from [piscord](https://github.com/Crokily/pi-discord-gateway) — same core engine, new Slack platform layer
- Architecture inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw)
- Built for [pi-mono](https://github.com/badlogic/pi-mono) by [@badlogic](https://github.com/badlogic)
