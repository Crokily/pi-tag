# Changelog

All notable changes to this project will be documented in this file.

## [0.2.1] - 2026-07-12

### Changed

- README rewritten around what you can do from Slack — user features and experience first, architecture and ops reference in the back half
- Slack app manifest description updated to match

## [0.2.0] - 2026-07-12

### Added

- Interactive Block Kit control panel: a bare `/pi` now opens an ephemeral panel with session status at a glance, model and thinking-level dropdowns (picked straight from pi's catalog — no more typing model refs), and confirmed New session / Stop buttons. Works over Socket Mode with no manifest changes; existing apps get it on gateway upgrade.
- `/pi help` shows the text usage (previously shown by a bare `/pi`).

## [0.1.0] - 2026-07-12

Initial release. Forked from [piscord](https://github.com/Crokily/pi-discord-gateway) v1.6.1 and ported from Discord to Slack.

### Added

- Slack Socket Mode gateway built on `@slack/bolt` — outbound WebSocket only, no public URL or inbound ports required
- App manifest (`manifest.yaml`) for one-step Slack app creation with the minimal bot scope set
- Per-channel pi sessions (`sl:<channelId>`) backed by the SQLite message queue with crash recovery and abort support
- Channel access policies (`open` / `open-trigger` / `allowlist`, default `allowlist`) and DM policy (`DM_POLICY`: `open` / `allowlist` / `disabled`, default `open`)
- Thread-aware replies (`REPLY_IN_THREAD`, default `true`): responses to messages inside a thread post back to that thread while sharing the channel session
- Global `/pi` slash command with text subcommands: `status` | `model <ref>` | `models` | `reset-model` | `thinking <level>` | `new` | `stop`
- Markdown responses via `chat.postMessage` `markdown_text` with automatic 4,000-character splitting and per-channel outbound pacing
- Busy indicator via hourglass reaction on the triggering message (Slack has no bot typing indicator)
- Attachment relay: `url_private` downloads authenticated with the bot token, passed to pi by local path
- Outbound files via Slack's three-step external upload (`files.getUploadURLExternal` → upload → `files.completeUploadExternal`)
- `pitag send` — text and file relay to any Slack channel over the Web API, no running gateway required
- File delivery from pi: each prompt teaches pi to share files via `pitag send`, and any `file://` reference left in a response is detected, validated against size limits, and uploaded as a native Slack attachment
- Bare trigger-name summons: `Coly fix this` works the same as `@Coly fix this` (prefix-only match)
- Rate-limited registration hint when the bot is @mentioned in an unregistered channel or DMed under `DM_POLICY=allowlist`
- Scheduled tasks (cron or one-time) that trigger pi sessions on schedule
- Interactive setup wizard (`pitag setup`), status diagnostics, and cross-platform daemon management (systemd/launchd) under the `pitag` service name
- Config file at `~/.config/pitag/config.env` (platform-aware), overridable via `PITAG_CONFIG`; Slack token validation (`xoxb-` / `xapp-` prefixes) at startup
