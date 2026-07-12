<h1 align="center">pi-tag</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-tag"><img src="https://img.shields.io/npm/v/pi-tag" alt="npm version"></a>
  <img src="https://img.shields.io/npm/l/pi-tag" alt="license">
  <img src="https://img.shields.io/node/v/pi-tag" alt="node version">
  <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-blue" alt="platform">
</p>

A lightweight Slack gateway for [pi coding agent](https://github.com/badlogic/pi-mono). Drive the pi running on **your own machine** from any Slack channel or DM. Socket Mode (no public URL, no inbound ports), SQLite-backed queue, per-channel session isolation, crash recovery, abort support. One command to set up, runs as a daemon, never drops a received message.

**Latest release:** see the npm version badge above and [Changelog](./CHANGELOG.md) for details.

```bash
npm install -g pi-tag
pitag setup                   # interactive wizard -- walks you through everything
```

That's it. The setup wizard checks prerequisites, walks you through creating the Slack app from the bundled manifest, asks for your two Slack tokens, lets you pick a channel policy, and optionally installs + starts a background service.

## Why self-hosted?

Cloud coding agents in Slack (Claude Code in Slack, Codex, Copilot coding agent) run on someone else's infrastructure against remote repositories, billed per seat or per API call. pi-tag is the orthogonal option: it bridges Slack to the **pi you already run locally** — your filesystem, your uncommitted working tree, your existing pi login and model access (any provider pi supports). Nothing about your code or credentials leaves your machine except the messages you exchange with Slack.

## Prerequisites

- **Node.js** ≥ 22.19 (same floor as the pi SDK)
- **Linux, macOS, or Windows**
- **[pi](https://github.com/badlogic/pi-mono)** ≥ 0.80 installed and on `PATH`, with login completed (`~/.pi/agent/auth.json`) — developed and tested against pi 0.80.6
- **A Slack workspace** where you can create apps (free plan is fine — pi-tag uses plain messages, no paid AI features)

## Quick Start

1. **Create the Slack app** — go to [api.slack.com/apps](https://api.slack.com/apps) → _Create New App_ → _From a manifest_ → pick your workspace → paste the contents of [`manifest.yaml`](./manifest.yaml) from this repository.
2. **Install it to your workspace** — _OAuth & Permissions_ → _Install to Workspace_, then copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Create the app-level token** — _Basic Information_ → _App-Level Tokens_ → generate a token with the `connections:write` scope (this is what Socket Mode uses), copy it (`xapp-…`).
4. **Run the wizard**:

   ```bash
   pitag setup
   ```

5. **Invite the bot** — `/invite @pi` in any channel, or just open a DM with it.
6. **Talk.** In DMs every message reaches pi. In channels it depends on your policy (see below) — with the default `allowlist` policy, register the channel first; in trigger-gated channels, summon the bot by @mentioning it or starting your message with its trigger name (`TRIGGER_NAME`, with or without a leading `@`).

## Features

- **Bridges to your existing `pi`** — shells out to the `pi` binary and reuses your login + model access
- **Socket Mode** — outbound WebSocket only; no public URL, no inbound ports, works behind any firewall/NAT
- **Per-channel sessions** — each Slack channel gets its own persistent conversation history
- **Thread-aware replies** — when you trigger pi from inside a thread, the answer lands in that thread
- **Per-channel working directories** — optionally override `PI_CWD` for specific channels without changing the global default
- **Channel access policy** — `allowlist` (manual registration, the default), `open` (all channels), or `open-trigger` (all channels, summon required: @mention or trigger-name prefix)
- **DM policy** — `open` (DMs auto-register), `allowlist`, or `disabled`
- **SQLite message queue** — survives crashes, auto-recovers stuck messages
- **Concurrency control** — per-channel serial processing + configurable global limit
- **`/pi` control panel** — a bare `/pi` opens an interactive Block Kit panel: status at a glance, model/thinking dropdowns, new-session and stop buttons; text subcommands (`status`, `model`, `models`, `reset-model`, `thinking`, `new`, `stop`) still work
- **Abort command** — `/pi stop` terminates the running task and clears queued messages
- **Attachment relay** — Slack file uploads are downloaded (with bot-token auth) and passed to `pi` by local path so agents can inspect or convert any supported file type without flooding context
- **Message and file sending** — `pitag send` lets pi send plain text, files, or both to any Slack channel; pi learns this per message, and any `file://` reference left in a response is auto-uploaded as a real attachment
- **Scheduled tasks** — cron or one-time tasks that trigger pi sessions on schedule
- **Markdown responses** — pi's standard Markdown is posted as-is (`markdown_text`), with automatic splitting at Slack's 4,000-character limit
- **Busy indicator** — an hourglass reaction on your message while `pi` processes (Slack has no bot typing indicator)
- **Archive auto-cleanup** — archived sessions are cleaned up after a configurable retention period
- **Daemon management** — systemd on Linux, launchd on macOS
- **Platform-aware paths** — XDG on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows

## How It Works

```
Slack ──Socket Mode (@slack/bolt)──→ Gateway ──pi subprocess──→ Pi Agent
                                        │                          │
                                      SQLite                  Session dirs
                                   (message queue)           (per channel)
```

The gateway **does not embed or replace `pi`**. It finds and runs your installed `pi`:

1. **Binary discovery** — uses `PI_BIN` config or finds `pi` in `PATH`
2. **Auth reuse** — `pi` reads its own `~/.pi/agent/auth.json` when invoked
3. **Model catalog** — the gateway imports the pi SDK to populate `/pi models` and model resolution
4. **Invocation** — each message is processed as `pi --session-dir <dir> --continue -p <message>`

Every received Slack event is acknowledged immediately and written to the SQLite queue before processing, so a crash or restart never loses an accepted message.

## Channel Policy

During setup you pick one of three policies. This controls how the bot behaves in channels it has been invited to:

| Policy         | Behavior                                                         |
| -------------- | ---------------------------------------------------------------- |
| `allowlist`    | Only manually registered channels are active. **(default)**      |
| `open`         | Channels auto-register on first message. No @mention needed.     |
| `open-trigger` | Channels auto-register, but the bot only responds when summoned. |

- "Summoned" means @mentioning the bot **or** starting the message with the trigger name — `@pi fix the build` and `pi fix the build` both work (`TRIGGER_NAME`, matched only at the start of a message). Pick a trigger word that doesn't collide with a teammate's name.
- Slack only delivers channel messages after the bot is **invited** (`/invite @pi`), so even `open` mode is gated by the invite.
- Summoning the bot in an **unregistered** channel (or DMing it under `DM_POLICY=allowlist`) gets a short registration hint instead of silence, rate-limited to once per 10 minutes per channel.
- Use `EXCLUDED_CHANNELS` to block specific channel IDs from auto-registration in `open` / `open-trigger` mode.
- Register channels by their **channel ID** (`C…` for public, `G…` for private), not by `#name`. Find the ID at the bottom of the channel's _About_ tab.

If you chose `allowlist`, register channels manually:

```bash
pitag register C0123456789 "my-workspace #general" --no-trigger
pitag register C0123456789 "my-workspace #general" --cwd /srv/repos/app
```

Re-running `pitag register` with `--cwd` updates that channel's working directory override. If no override is set, the gateway uses the global `PI_CWD`.

### DM Policy

`DM_POLICY` controls direct messages independently of the channel policy:

| Policy      | Behavior                                                  |
| ----------- | --------------------------------------------------------- |
| `open`      | DM channels auto-register on first message. **(default)** |
| `allowlist` | Only DMs registered via `pitag register` get responses.   |
| `disabled`  | All DMs are ignored.                                      |

Note: `DM_POLICY` governs one-to-one DMs only. Group DMs (mpim) behave like channels and follow `CHANNEL_POLICY` — under the default `allowlist` they stay inactive unless registered.

## Sessions and Threads

- **One session per channel.** Each registered channel (or DM) maps to its own pi session directory; conversation history persists across messages via `pi --continue`.
- **`/pi new` rotates the session** — the old one is archived (and cleaned up after `ARCHIVE_RETENTION_DAYS`).
- **Thread replies land in-thread** — with `REPLY_IN_THREAD=true` (the default), triggering pi from inside a thread posts the answer back to that thread. Threads still **share the channel's session**; they are a reply location, not a separate conversation.

## Slash Commands

The app manifest registers a global `/pi` command. A bare `/pi` opens an **interactive control panel** (ephemeral — only you see it): session status at a glance, model and thinking-level dropdowns you can pick from, and New session / Stop buttons with confirmation. This is the easiest way to drive the gateway — no subcommands or model refs to remember.

Text subcommands still work for muscle memory and scripting (replies are ephemeral too):

| Subcommand          | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `/pi`               | Open the interactive panel (status + pickers + buttons)            |
| `/pi help`          | Show text usage                                                    |
| `/pi status`        | Show model, thinking, working directory, session info, token usage |
| `/pi model <ref>`   | Set the channel's model (fuzzy-matched against pi's catalog)       |
| `/pi models`        | List the models pi can currently use                               |
| `/pi reset-model`   | Clear the channel's model override                                 |
| `/pi thinking <lv>` | Set thinking level: off / minimal / low / medium / high / xhigh    |
| `/pi new`           | Start a fresh session for this channel                             |
| `/pi stop`          | Abort the current task and clear queued messages                   |

`/pi model` reads the catalog from the configured `PI_BIN`, so it stays in sync when pi adds or removes models. It also honors pi's `enabledModels` setting (configured through `/scoped-models`), including model order and glob patterns. If no scope is configured, it shows all available models.

## Tools for Pi

The gateway exposes two capabilities through its CLI that **pi itself can invoke**. You don't type these commands in your terminal — you just tell pi in Slack, and it handles the rest.

For example, you can say to pi:

> _"Create a daily task at 9am UTC that generates a summary report"_
> _"Send me report.pdf with a message saying here you go"_
> _"Set a one-time reminder for the 2pm meeting today"_

pi will run the appropriate `pitag task` or `pitag send` command behind the scenes.

### Scheduled tasks

pi can schedule cron-based or one-time prompts through the gateway's scheduler. Tasks are injected into the normal message queue, so they use the channel's configured model, thinking level, and working directory.

Under the hood, pi runs commands like:

```bash
pitag task add \
  --name "daily-report" \
  --schedule "0 9 * * *" \
  --channel sl:C0123456789 \
  --prompt "Generate today's summary report"

pitag task add \
  --name "meeting-reminder" \
  --schedule "2026-08-05T14:00:00Z" \
  --channel sl:C0123456789 \
  --prompt "Remind Colin about the 2pm meeting" \
  --once
```

The `--schedule` value uses standard 5-field cron syntax (`minute hour day month weekday`). For one-time tasks, add `--once` and pass an ISO 8601 datetime.

**Task management** — also available via pi:

```bash
pitag task list              # List all tasks
pitag task disable <id>      # Pause
pitag task enable <id>       # Resume
pitag task remove <id>       # Delete
```

### Sending messages and files to Slack

pi can send plain text messages, files, or both to any Slack channel using the gateway's built-in relay.

When you ask pi to send something, it runs commands like:

```bash
pitag send --channel sl:C0123456789 --text "hello"
pitag send --channel sl:C0123456789 --file /path/to/report.pdf --text "Here's the report"
pitag send --channel sl:C0123456789 --file chart.png --file data.csv
```

- `--text` works on its own
- Up to 10 files per message
- Respects `MAX_ATTACHMENT_BYTES` per file
- Files go through Slack's three-step external upload API
- Works independently — no running gateway daemon required

## Daemon Management

The setup wizard offers to install a background service automatically. You can also manage it manually:

```bash
pitag daemon install   # Generate + enable service
pitag daemon start     # Start
pitag daemon status    # Check status
pitag daemon logs      # Tail log output
pitag daemon stop      # Stop
pitag daemon uninstall # Remove the service
```

- **Linux** — uses a systemd user service (`pitag`)
- **macOS** — uses a launchd user agent (`com.pitag`)
- **Windows** — daemon management is not yet supported; run `pitag start` in a terminal or use Task Scheduler manually

> **Headless Linux servers**: enable user lingering so the service runs without an active login session:
>
> ```bash
> sudo loginctl enable-linger $USER
> ```

## Configuration Reference

Config file location depends on your OS (see Data Locations). On Linux: `~/.config/pitag/config.env`

Most users won't need to edit this file directly — `pitag setup` generates it for you. If you do want to tweak advanced settings, you can edit the file manually, or ask your pi to configure it for you. Run `pitag status` to see the config path on your system. The `PITAG_CONFIG` environment variable overrides the config file path.

| Variable                     | Default                         | Description                                                                |
| ---------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`            | _(required)_                    | Bot User OAuth Token (`xoxb-…`)                                            |
| `SLACK_APP_TOKEN`            | _(required)_                    | App-level token with `connections:write` for Socket Mode (`xapp-…`)        |
| `PI_BIN`                     | `pi`                            | Path to pi binary                                                          |
| `PI_MODEL`                   | _(none)_                        | Default model override                                                     |
| `PI_THINKING`                | _(none)_                        | Default thinking level                                                     |
| `PI_CWD`                     | `$HOME`                         | Default working directory for pi; can be overridden per registered channel |
| `PI_EXTRA_FLAGS`             | _(none)_                        | Extra flags passed to pi                                                   |
| `TRIGGER_NAME`               | `pi`                            | Bot trigger name for @mentions                                             |
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
| `MAX_TOTAL_ATTACHMENT_BYTES` | `52428800`                      | Max combined attachment size (0 = no limit)                                |
| `MEDIA_RETENTION_HOURS`      | `168`                           | Hours to keep downloaded attachment files for path-based agent access      |
| `SESSIONS_DIR`               | _(platform default)_/sessions   | Session storage directory (see Data Locations)                             |
| `DB_PATH`                    | _(platform default)_/gateway.db | SQLite database path (see Data Locations)                                  |
| `LOG_LEVEL`                  | `info`                          | Log level: debug/info/warn/error                                           |

After changing config, restart the service: `pitag daemon stop && pitag daemon start`

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

pitag help                                    Show help
```

Channel jids are the Slack channel ID with an `sl:` prefix (e.g. `sl:C0123456789`); bare IDs are accepted and prefixed automatically.

### Register options

| Flag              | Effect                                        |
| ----------------- | --------------------------------------------- |
| `--no-trigger`    | Respond to all messages (not just @mentions)  |
| `--main`          | Mark as main channel (implies `--no-trigger`) |
| `--folder <name>` | Custom session folder name                    |
| `--cwd <path>`    | Override `PI_CWD` for this channel only       |

## Data Locations

Paths are platform-aware. Defaults by OS:

| Item     | Linux                             | macOS                                            | Windows                           |
| -------- | --------------------------------- | ------------------------------------------------ | --------------------------------- |
| Config   | `~/.config/pitag/config.env`      | `~/Library/Application Support/pitag/config.env` | `%APPDATA%\pitag\config.env`      |
| Database | `~/.local/share/pitag/gateway.db` | `~/Library/Application Support/pitag/gateway.db` | `%LOCALAPPDATA%\pitag\gateway.db` |
| Sessions | `~/.local/share/pitag/sessions/`  | `~/Library/Application Support/pitag/sessions/`  | `%LOCALAPPDATA%\pitag\sessions\`  |
| pi auth  | `~/.pi/agent/auth.json`           | `~/.pi/agent/auth.json`                          | `~/.pi/agent/auth.json`           |

## Alternative Installation

### npx (quick trial, no global install)

```bash
npx pi-tag@latest setup
```

### From source

```bash
git clone https://github.com/Crokily/pi-tag.git
cd pi-tag
npm install && npm run build
node dist/cli/index.js setup
```

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
- **macOS**: check `daemon.stdout.log` / `daemon.stderr.log` in the data directory (see Data Locations)
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

## Development

```bash
npm install
npm run dev          # Start with tsx (no build needed)
npm run build        # Compile TypeScript
npm test             # Run Vitest suite
```

## Security

Read this section before exposing the bot to anyone but yourself.

- **Whoever can message the bot drives a local coding agent with your shell and filesystem access.** Treat access to a registered channel like SSH access to the machine running the gateway. This is why `CHANNEL_POLICY` defaults to `allowlist` — keep it that way unless you fully trust everyone in the workspace, and consider `DM_POLICY=allowlist` or `disabled` too.
- **Prompt injection is real.** Anything sent to a registered channel reaches pi's context: other people's messages, attachment contents, text pasted from elsewhere. pi may follow instructions embedded in that content. Prefer trigger-gated channels and don't register busy public channels.
- **Never run two instances against the same Slack app.** Socket Mode load-balances events between connections — a second instance will silently take half the messages and split your sessions. The systemd/launchd daemon is naturally single-instance; just don't also run `pitag start` by hand.
- **Protect `config.env`** — it contains both Slack tokens (`chmod 600`). The `xoxb-` token can read shared files and post as the bot in every channel it has joined.
- Anyone who can message a registered channel can spend your pi usage.
- Review attachment size limits before exposing the bot.
- Run the service as a normal user, not root.

Scope note: the bundled manifest requests the minimal scope set the gateway uses (message events for channels/groups/DMs, `chat:write`, files read/write, `reactions:write`, `users:read`, `channels:read`/`groups:read`/`mpim:read` for readable auto-registration labels, `commands`). The gateway never pulls channel history — it only sees the events Slack pushes to it.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## License

MIT

## Version History

| Version | Date       | Changes                                             |
| ------- | ---------- | --------------------------------------------------- |
| 0.1.0   | 2026-07-11 | Initial release — Slack Socket Mode port of piscord |

See [Changelog](./CHANGELOG.md) for full details.

## Acknowledgments

- Forked from [piscord](https://github.com/Crokily/pi-discord-gateway) — same core engine, new Slack platform layer
- Architecture inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw)
- Built for [pi-mono](https://github.com/badlogic/pi-mono) by [@badlogic](https://github.com/badlogic)
