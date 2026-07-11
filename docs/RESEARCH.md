# 基于 Piscord 构建 Slack Gateway 独立仓库：深度技术调研报告

- **调研日期**：2026-07-11（所有外部事实均为当日检索；Piscord 源码基于本仓库 `feat/respect-pi-scoped-models` 分支，v1.6.1）
- **调研方法**：本地源码逐文件精读 + 三路并行研究（Slack 官方文档 docs.slack.dev / 开源对标项目 / Vercel chat & AI 连接器生态），关键事实附直接来源链接
- **标注约定**：【事实】= 有源码或文档来源；【推断】= 基于事实的分析判断；【建议】= 设计决策建议
- **约束**：本报告为调研产物，未修改任何业务代码

---

## 1. Executive Summary

基于 Piscord 新建一个支持 Slack 的独立仓库**合理且性价比高**。Piscord 事实上已是隐式的"端口-适配器"架构：Discord 耦合集中在 `src/discord/`（约 1,000 行，占 20%），核心资产（SQLite 队列、pi 子进程驱动、会话目录管理、模型目录、调度器、跨平台守护进程，约 80%）可直接平移。技术路线明确：**Socket Mode + `@slack/bolt`（每用户在自己 workspace 自建 app）**，与 Piscord 的"WebSocket 长连接 + 本机守护进程"形态同构，无需公网端口，且作为 internal app 完全豁免 Slack 2025-2026 收紧的第三方限流。生态位真实存在：pi 官方 `pi-chat` 只桥接 Discord/Telegram，社区无成熟 pi×Slack 项目。预计新写/重写约 1,200-1,500 行即可达到与 Piscord 对等的 MVP，1-2 周可交付。

## 2. Key Findings

1. **【事实】Piscord 的平台耦合面极小且边界清晰**：核心层对 Discord 的全部依赖只有 4 处 import——`agent/queue.ts:22`（`sendResponse`/`setTyping`）、`agent/invoke.ts:3` 与 `session/media.ts:14`（仅 `AttachmentMeta` 类型）、`index.ts:4`（生命周期函数）；jid 前缀 `dc:` 只出现在 `src/discord/*` 和 `cli/index.ts:652`。替换 `src/discord/` 即完成移植的主体。
2. **【事实】Socket Mode 是 Slack 官方为"防火墙后自托管"提供的一等公民通道**：`apps.connections.open` 换临时 wss URL、SDK 自动重连、无需公网 Request URL；代价是不能上架 Marketplace（对"每用户自建 app"模式无影响）。（[Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)）
3. **【事实】"每用户自建 app = internal customer-built app"避开了 Slack 2025-05-29 起对非 Marketplace 商业分发 app 的限流重拳**（`conversations.history/replies` 降至 1 次/分钟、每次 15 条；2026-03-03 扩展到存量安装，内部自建 app 始终豁免）。这是本项目分发模式的关键架构依据。（[限流变更](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)、[官方澄清](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/)）
4. **【事实】`chat.postMessage` 的 `markdown_text` 字段已 GA（标准 Markdown，上限 12,000 字符）**，pi 输出的标准 Markdown 无需转换为 Slack 传统 mrkdwn——消除了 Slack 移植中最恼人的格式问题。（[chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)）
5. **【事实】生态位空白**：pi 官方桥接项目 `earendil-works/pi-chat` 仅支持 Discord/Telegram；pi-mono 曾有的 Slack bot（`packages/mom`）已移除；channel 抽象提案 issue #1253 关闭无回应；社区 pi×Slack 项目均为 2-25 star 玩具级。（[pi-chat](https://github.com/earendil-works/pi-chat)、[issue #1253](https://github.com/badlogic/pi-mono/issues/1253)）
6. **【事实】对标项目高度共识**：OpenClaw、NanoClaw、cc-connect、mpociot/claude-code-slack-bot 等自托管 agent 网关全部选择 Socket Mode + Bolt；NanoClaw（30k stars）使用与 Piscord 同构的 SQLite 队列并以此为卖点；其 Slack 实现自曝"线程拍平、无 typing、无附件、粗暴分片"四大局限——正是新仓库可差异化超越之处。（[nanoclaw](https://github.com/qwibitai/nanoclaw)、[nanoclaw slack skill](https://nanoclaw.dev/skills/slack/)）
7. **【推断】纯 Vercel 托管对本产品不可行、混合中继不划算**：pi 的执行体、`auth.json` 订阅凭据与目标工作区都在用户本机，Vercel Functions/Sandbox 无法触达；Socket Mode 本身就是 Slack 免费运营的官方 relay。Vercel 生态中真正可借鉴的是 `vercel/chat` SDK 的多平台适配器设计与其 Slack Socket Mode 支持。（[chat-sdk.dev Slack adapter](https://chat-sdk.dev/adapters/official/slack)）

---

## 3. Detailed Analysis

### 3.1 Piscord 现状：架构、可复用资产与耦合点（本地源码事实）

【事实】数据流（`src/index.ts`、`src/agent/queue.ts`）：

```
Discord 消息 (discord.js WebSocket Gateway)
  → handleMessage：bot 过滤 → jid=dc:<channelId> → mention→@trigger 归一化
    → 附件限额筛选 → [Reply to X] 回复上下文 → 频道策略/自动注册 → 触发判断
  → SQLite 队列 (better-sqlite3, WAL, 原子 claim)
  → 轮询循环 (1s)：每频道串行 + 全局并发上限 (默认 3)
  → pi 子进程：pi --session-dir <频道会话目录> --continue [--model] [--thinking] -p <prompt>
  → sendResponse：2,000 字符按换行分片回发 + typing 循环 (8s)
```

【事实】代码规模与依赖：全仓约 5,069 行 TypeScript（ESM，Node ≥20）；运行时依赖 discord.js ^14.18、better-sqlite3 ^12、croner ^10、pino、dotenv、minimatch、@clack/prompts；peerDependencies `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`。

【事实】Discord 专属代码约 1,003 行（约 20%）：

| 文件                            | 行数 | 内容                                                                                |
| ------------------------------- | ---- | ----------------------------------------------------------------------------------- |
| `src/discord/client.ts`         | 325  | Gateway 连接、intents、handleMessage 入站归一化、sendResponse/setTyping 出站        |
| `src/discord/slash-commands.ts` | 526  | `/pi status\|model\|reset-model\|thinking\|new\|stop`，autocomplete，ephemeral 回复 |
| `src/discord/send.ts`           | 85   | `piscord send` 用的一次性 Discord 客户端                                            |
| `src/discord/attachments.ts`    | 67   | 附件限额筛选（**实为平台无关纯函数**）                                              |

【事实】核心层对 Discord 的全部依赖（grep 精确核对）：

- `src/agent/queue.ts:22` — `import { sendResponse, setTyping } from '../discord/client.js'`（唯一的出站调用缝）
- `src/agent/invoke.ts:3`、`src/session/media.ts:14` — 仅导入 `AttachmentMeta` 类型
- `src/index.ts:4` — `startDiscord/stopDiscord/getBotTag` 生命周期
- jid 前缀 `dc:` 仅存在于 `src/discord/*` 与 `src/cli/index.ts:652`（`toDiscordChannelJid`）

【事实】可直接复用的平台无关资产（约 80%）：

| 模块                                     | 复用度 | 说明                                                                                                                                                                   |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db.ts`                              | 原样   | channels / message_queue / message_log / scheduled_tasks 四表；`claimNextMessage` 原子 `UPDATE…RETURNING`；`recoverStuckMessages` 崩溃恢复；`ensureTableColumn` 微迁移 |
| `src/agent/queue.ts`                     | 小改   | 轮询、每频道串行、并发上限、AbortController 中止、优雅排空——仅需把 `sendResponse/setTyping` 改为注入/换 import                                                         |
| `src/agent/invoke.ts`                    | 小改   | pi 子进程 spawn、`--session-dir --continue`、附件路径注入 `<attachments>`、SIGTERM→SIGKILL 中止、JSONL 错误提取、RPC 会话统计                                          |
| `src/agent/model-catalog.ts`             | 原样   | 每 cwd 30s 缓存、pi SDK registry + `--list-models` 合并、enabledModels glob、模糊解析、thinking 钳制                                                                   |
| `src/agent/channel-settings.ts`          | 原样   | model/thinking/cwd 三级解析（频道覆盖 → 网关默认 → pi 运行时默认）                                                                                                     |
| `src/agent/scheduler.ts`                 | 原样   | croner 30s tick，到期任务以消息身份入队（sender='scheduler'），天然平台无关                                                                                            |
| `src/agent/pi-spawn.ts`                  | 原样   | Windows .cmd shim 解析                                                                                                                                                 |
| `src/session/path.ts`                    | 小改   | 目录名防穿越、会话目录轮换 `__archived_<stamp>`（需为 thread_ts 加字符清洗）                                                                                           |
| `src/session/media.ts`                   | 小改   | 附件下载/清理（Slack 需加 Bearer 头，见 3.5）                                                                                                                          |
| `src/session/archive-cleanup.ts`         | 原样   | 归档保留期清理                                                                                                                                                         |
| `src/config.ts`                          | 小改   | config.env + 环境变量分层、XDG/macOS/Windows 路径（token 键名替换）                                                                                                    |
| `src/cli/*`（setup/daemon/status/index） | 小改   | clack 向导、systemd/launchd 守护、诊断（文案与 token 校验替换）                                                                                                        |
| `src/types.ts`、`src/logger.ts`          | 原样   | `RegisteredChannel`/`QueuedMessage` 等均无平台字段                                                                                                                     |

【推断】Piscord 事实上已按"端口-适配器"组织，只是端口未显式命名。整个平台缝隙就是：`sendResponse(jid, text)`、`setTyping(jid)`、`AttachmentMeta`、生命周期三函数、jid 前缀。这意味着移植成本主要是**重写一个约千行的平台层**，而不是重构核心。

### 3.2 Slack 技术选型：连接模式、SDK、CLI（外部事实 + 建议）

**连接模式**（[Events API](https://docs.slack.dev/apis/events-api/)、[Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)）：

|             | Events API (HTTP)                                      | Socket Mode (WebSocket)                                   |
| ----------- | ------------------------------------------------------ | --------------------------------------------------------- |
| 公网要求    | 必须有公网 Request URL                                 | 无（outbound wss，`apps.connections.open` 换临时 URL）    |
| 应答约束    | 3 秒内 200，否则重试 3 次；60 分钟失败率 >95% 暂停订阅 | envelope + `envelope_id` ack，无 3 秒硬时限（应尽快 ack） |
| 掉线补投    | 有（重试机制）                                         | **无**（掉线期间事件不补投；SDK 自动重连）                |
| 连接数      | —                                                      | 最多 10 条；事件负载均衡单投递，**不是广播**              |
| Marketplace | 可上架                                                 | **禁止上架**（仅内部/org 部署）                           |

【建议】**选 Socket Mode**。理由：与 Piscord 的 discord.js Gateway 模型同构（本机守护进程、无入站端口）；"每用户自建 app"本就不上 Marketplace；对标项目全体共识（OpenClaw 默认、NanoClaw、cc-connect、mpociot、slack-machine 均为 Socket Mode，仅 cc-slack 用 Events API 且需 ngrok）。可学 OpenClaw 把 HTTP 模式留作远期可选配置（[OpenClaw Slack docs](https://docs.openclaw.ai/channels/slack)）。

**SDK**（[bolt-js releases](https://github.com/slackapi/bolt-js/releases)）：

- 【事实】`@slack/bolt` 最新 4.7.3（2025-05-27 发布，至检索日 13 个月无新版本，但无弃用声明，仍是官方主推）；依赖 `@slack/web-api ^7.16`、`@slack/socket-mode ^2.0.7`，两者正常维护。v4.7 起内置 `Assistant` class（`setStatus`/`sayStream` 等 AI 封装）。
- 【建议】**MVP 用 `@slack/bolt`（SocketModeReceiver）**：统一封装事件 ack、重连、slash command / 交互 payload 管线，是全部对标项目的共同选择。将平台层做薄（所有 Bolt 调用集中在 `src/slack/` 内），若 Bolt 停更成为问题，可无痛降级为 `@slack/socket-mode` + `@slack/web-api` 裸组合（Bolt 内部即此二者）。2026-06 的 `agent_view` 等新特性 Bolt 尚未封装，需要时直调 Web API。

**App 配置与 CLI**（[App Manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests)、[Slack CLI](https://docs.slack.dev/tools/slack-cli/)）：

- 【事实】App Manifest（YAML/JSON）生产可用，可声明 scopes、事件订阅、Socket Mode、slash commands；Slack CLI 可从 manifest 建 app、本地运行。
- 【建议】仓库内置 `manifest.yaml`，README 引导用户"Create app from manifest"一键建 app（对应 Piscord README 的 Discord Application 创建指引，体验更好）；Slack CLI 作可选路径，不强依赖。

**AI Apps 特性（可选增强）**（[Developing AI apps](https://docs.slack.dev/ai/developing-ai-apps)、[chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream)）：

- 【事实】`assistant.threads.setStatus/setTitle/setSuggestedPrompts`、流式 `chat.startStream/appendStream/stopStream`（2025-10-07）、thinking steps blocks（2026-02-11）、`agent_view` 取代 `assistant_view`（2026-06-30，新 app 必用，迁移不可逆）；**部分 AI 特性需付费计划**（开发者沙箱免费全功能）。
- 【建议】核心链路只用普通 DM/频道消息（兼容免费 workspace），AI 专属界面与流式输出作为 Phase 3 可选增强。

### 3.3 开源对标与生态位（外部事实 + 推断）

【事实】关键对标（详见 References）：

- **OpenClaw**（约 38 万 stars）：`@openclaw/slack` 插件用 Bolt 4.7.3 + Socket Mode（默认）；会话键 `agent:<id>:slack:channel:<channelId>`，线程会话是可选叠加 `...:thread:<threadTs>`，**频道顶层消息永远走频道会话**；配置面含 `replyToMode: off|first|all|batched`、`dmPolicy: pairing|allowlist|open|disabled`、`requireMention`、8,000 字符分片、20MB 媒体上限。
- **NanoClaw**（30.2k stars，Piscord 架构灵感来源）：host router + 每会话 inbound.db/outbound.db 单写者 SQLite 队列——与 Piscord 队列同构的独立验证；其 Slack skill 自曝局限：线程拍平、无 typing、无文件处理、按字符粗暴分片。
- **cc-connect**（13.8k stars，Go）：CLI 子进程 × 多平台赛道体量最大；每会话 spawn CLI、空闲 30 分钟自动轮换会话（防"上下文漂移"）、`/new` `/switch` `/list`、卡死自动恢复。
- **官方产品交互范式**（Claude Code in Slack / Claude Tag / Codex / Copilot coding agent）：统一为 **@mention 召唤 + 线程即任务上下文 + 进度与结果回线程**（[Slack 官方博客归纳](https://slack.com/blog/developers/coding-agents-in-slack)）。Claude Code in Slack 文档明确警示 prompt injection（"Claude may follow directions from other messages in the context"）。
- **pi 生态**：pi（earendil-works/pi，69.5k stars，v0.80.6）官方桥 `pi-chat` 仅 Discord/Telegram；monorepo 的 Slack bot（mom）已移除；channel 抽象 issue #1253 关闭无回应——**官方无 Slack 计划，社区无成熟替代**。
- **通用框架已死或不适用**：hubot-slack 2025-05-27 官方归档；matterbridge 半休眠；LLM 模板均为 Bolt 薄封装、无持久队列。

【推断】三点结论：

1. 生态位真实存在且窗口开放——pi-slack-gateway 无官方竞品，且 pi 官方明确不做 channel 抽象。
2. Piscord 的 SQLite 持久队列在 Slack 语境下**不是过度设计而是刚需**：Socket Mode 掉线不补投、Events API 官方最佳实践即"queue events for asynchronous processing"；多数社区桥没有队列，这是差异化卖点。
3. 官方云端产品（Claude Tag、Codex）走团队付费托管路线；**自托管 + 本机文件系统 + pi 多 provider 订阅登录**是与之正交的护城河（aimaestro-slack-bridge 的自我定位印证此叙事）。

### 3.4 Vercel 生态评估（外部事实 + 推断）

【事实】：

- Vercel 官方 Slack 路线收敛为"Events API webhook + 3 秒 ack（`waitUntil`/Workflows）+ 代码跑在 Vercel"：vercel-labs/ai-sdk-slackbot、`@vercel/slack-bolt`（VercelReceiver）、Slack Agent Template。
- `vercel/chat`（npm `chat` v4.33.0，2.2k stars，540 releases）：多平台 bot SDK（Slack/Discord/Telegram/Teams…），`@chat-adapter/slack` 默认 webhook 但**在长驻进程下支持 Socket Mode**；state 默认面向 Redis。
- AI SDK v7 的 Harnesses（实验性，2026-06-12）已包含 `@ai-sdk/harness-pi`：在宿主进程内跑 pi agent loop，但认证走 `AI_GATEWAY_API_KEY`/provider API key + sandbox 文件系统，**不是本机 `auth.json` 订阅登录**。
- Vercel Sandbox（GA，Firecracker，可装任意二进制，Hobby 45 分钟 / Pro 24 小时上限）技术上能跑 pi CLI。

【推断】：

1. **纯 Vercel 部署对本产品目标不可行**——不是平台能力不足，而是产品语义不同：pi 的执行、订阅凭据、目标仓库工作区（含未提交状态）都在用户本机；搬进 Sandbox 就变成"云端编码代理"（API key 计费、只能 clone 远端仓库），那是 Vercel Harness 生态自己在做的另一个产品。
2. **混合中继（Vercel 收 webhook → 转发本机守护进程）存在但不划算**：唯一实质优势是多租户 Marketplace 分发与集中 token 管理；代价是重新发明 Slack 已免费运营的官方 relay（Socket Mode）、多一跳延迟、云端多存一份 token。仅当目标变为"上架 Marketplace 的多租户产品"时才值得引入。
3. 可借鉴资产：`vercel/chat` 的多平台适配器接口设计（若远期想统一 Discord/Slack 双仓库的平台层抽象，可参考其 adapter 形状）；`@ai-sdk/harness-pi` 可作为远期可选的"云端直连模式"，非当前路径。

### 3.5 语义映射：消息 / 线程 / 队列 / 会话

**概念映射表**（【事实】列为两平台文档/源码行为；"映射"列为【建议】）：

| Piscord (Discord)                                       | Slack 对应                                                                                                                                                          | 映射设计                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jid = dc:<channelId>`                                  | channel id（`C…` 公开 / `G…` 私有 / `D…` DM / mpim）                                                                                                                | `jid = sl:<channelId>`；线程派生会话 `sl:<channelId>:t:<threadTs>`（thread_ts 中 `.` 清洗为 `-` 再入目录名，`session/path.ts` 已有防穿越校验可复用）                                                                      |
| Gateway intents + MessageContent                        | 事件订阅 `message.channels/groups/im/mpim`（需对应 `*:history` scopes）                                                                                             | 只订阅 message 族，不依赖 `app_mention` 事件：Piscord 的 open/open-trigger 策略本就需要看到全部消息；mention 检测走文本 `<@U…>` 归一化（与现有 mention→`@trigger` 策略同构），同时规避 app_mention/message 双投递去重问题 |
| bot 消息过滤（`author.bot`）                            | 过滤 `bot_id`、`subtype: bot_message`、自身 user id（auth.test 获取）                                                                                               | 官方参考页无显式防回环指引，必须自行过滤（Bolt 生态通行做法）（[message event](https://docs.slack.dev/reference/events/message)）                                                                                         |
| mention `<@botId>` → `@trigger` 归一化                  | `<@U_BOT>` 文本替换                                                                                                                                                 | 逻辑照搬 `discord/client.ts`                                                                                                                                                                                              |
| `[Reply to X]` 回复上下文（message.reference）          | Slack 的"回复"即线程消息（携带 `thread_ts`）                                                                                                                        | MVP：线程内触发则回帖到同一线程（`thread_ts` 传父消息 ts，官方强调用父 ts）；会话仍走频道基座。Phase 3：线程派生独立会话                                                                                                  |
| DM 自动注册（Partials.Channel）                         | `message.im`（DM 无 app_mention 事件，官方明确）                                                                                                                    | DM 事件直接对应现有 DM 策略；主动开 DM 用 `conversations.open`（`im:write`）                                                                                                                                              |
| 频道策略 open / open-trigger / allowlist                | bot 需被 `/invite` 进频道才收 `message.channels`                                                                                                                    | 语义天然收紧：注册被邀请动作门控；allowlist 用 `C…` ID（OpenClaw 文档特别警告勿用 `#名字`）                                                                                                                               |
| `setTyping` 8s 循环                                     | 现代 Slack API 无 bot typing indicator；AI apps 的 `setStatus` 是官方等价物但付费墙                                                                                 | 【建议】`reactions.add`（⏳/👀）于触发消息、完成后移除 + 可选 `setStatus`（付费 workspace）。NanoClaw 无 typing 被其自认局限，此处是差异化点                                                                              |
| `sendResponse` 2,000 字符按换行分片                     | `text` 建议 ≤4,000（40,000 截断）；`markdown_text` 12,000 标准 Markdown；`chat.update` 的 `msg_too_long` 口径为 4,000                                               | 优先 `markdown_text`（免 mrkdwn 转换）；分片阈值按 ≤4,000/条设计（两口径取严）；复用 `splitMessage` 换行切分逻辑改参数；出站限速 ~1 msg/s/channel                                                                         |
| 附件下载（公网 CDN 裸 fetch，`session/media.ts`)        | `url_private` 必须带 `Authorization: Bearer <xoxb>` 头                                                                                                              | `downloadAttachments` 增加可选 headers 参数（唯一必改的核心层函数）                                                                                                                                                       |
| 附件出站（`piscord send` ≤10 文件）                     | `files.upload` 已于 2025-11-12 关闭；新流程 `files.getUploadURLExternal` → POST → `files.completeUploadExternal`（支持 `channel_id`/`thread_ts`/`initial_comment`） | 实现三步上传；`send` CLI 反而更简单——纯 Web API 调用，无需像 Discord 那样起一次性 Gateway 连接                                                                                                                            |
| `/pi` slash 命令（guild 注册、autocomplete、ephemeral） | 全局 `/pi` slash command（`commands` scope，Socket Mode 同样送达）；**无 autocomplete 机制**；ephemeral 用 `response_url`/`chat.postEphemeral`                      | 子命令走文本解析：`/pi status\|model <ref>\|models\|reset-model\|thinking <level>\|new\|stop`；模型选择靠已有 `resolveModelReference` 模糊匹配 + `/pi models` 列表（Phase 3 可加 Block Kit static_select）                |
| `[Discord user: <name>]` prompt 前缀                    | `users:read` 取 display name                                                                                                                                        | `[Slack user: <display_name>]`，缓存 user id → name                                                                                                                                                                       |
| 定时任务（scheduled_tasks，目标 jid）                   | 平台无关                                                                                                                                                            | 原样复用（jid 换 `sl:` 前缀即可）                                                                                                                                                                                         |
| `getBotTag()`                                           | `auth.test`（bot user id、team）                                                                                                                                    | 启动日志 + mention 归一化的 bot id 来源                                                                                                                                                                                   |

**队列与会话语义**（【事实】+【建议】）：

- 队列语义**零改动**：`message_queue` 表、原子 claim、每频道串行、全局并发、`recoverStuckMessages`、abort 全部平台无关。Socket Mode 收到事件应立即 ack 再入队异步处理——与 Piscord "收到即入队" 完全一致，且补齐了 Socket Mode 掉线不补投之外的所有可靠性缺口。
- 会话模型采用**双层结构**（证据见 3.3）：
  - **基座**：每频道一会话（`sl:<channelId>` → 独立 session-dir + `pi --continue`），对齐 Piscord 与 OpenClaw（"频道顶层消息永远走频道会话"）；`/pi new` 轮换归档照旧。
  - **增量（Phase 3）**：`thread_ts` 派生子会话（独立 session-dir），对齐全部官方编码代理（Codex/Copilot/Claude Code in Slack 均"线程=任务容器"）与 Slack 用户强线程习惯；NanoClaw 的"线程拍平"是其自认局限，勿重蹈。
  - 可选会话卫生：借鉴 cc-connect 的空闲自动轮换与 OpenClaw 的每日重置（现有 scheduler 基础设施可承载）。

### 3.6 推荐架构

**仓库策略**：【建议】**独立仓库 + fork-and-replace**（如 `pi-slack-gateway`，bin 名可用 `pislack`）。

- 【推断】理由：(a) 先例一致——pi-chat 独立于 pi-mono、nanocoai 按渠道拆仓；(b) 双平台用户画像与文档、setup 向导、manifest 完全不同，独立 README/npm 包更清晰；(c) 现在抽共享 core 包是过早抽象——两个消费者才刚出现，接口尚未被第二个实现锤炼过，且会给 Piscord 引入破坏性重构（违背"不动现有业务代码"的现实约束）。
- 【建议】在新仓库内**显式**定义平台端口接口（Piscord 中隐式存在的缝隙），为远期抽 core 包留好断面：

```ts
// src/platform/adapter.ts —— 唯一的平台缝
export interface PlatformAdapter {
  start(): Promise<void>;
  stop(): void;
  getBotTag(): string;
  sendResponse(jid: string, text: string): Promise<void>;
  setBusy(jid: string, on: boolean, ctx?: { ts?: string }): Promise<void>; // typing/reaction 抽象
}
```

- 【建议】若未来确需双仓共享 core，再按"rule of three"抽 `@crokily/pi-gateway-core`；届时 `vercel/chat` 的 adapter 接口形状可作参考。

**新仓库目录结构**（【建议】）：

```
src/
  index.ts            # 小改：startSlack 生命周期
  config.ts           # 小改：SLACK_BOT_TOKEN + SLACK_APP_TOKEN（xoxb-/xapp- 前缀校验）
  types.ts / logger.ts / db.ts        # 原样（AttachmentMeta 移入 types.ts）
  slack/
    client.ts         # 重写：Bolt SocketModeReceiver、message 事件归一化、sendResponse(markdown_text+4k 分片+限速)、reactions busy 指示、防回环
    commands.ts       # 重写：/pi 文本子命令解析（复用 channel-settings/model-catalog 全部逻辑）
    files.ts          # 新增：uploadV2 三步 + url_private Bearer 下载封装
    send.ts           # 重写：piscord send 对应（纯 Web API，更简单）
  platform/attachments.ts  # 移动：原 discord/attachments.ts（本就平台无关）
  agent/   (queue/invoke/model-catalog/channel-settings/scheduler/pi-spawn)  # 原样/小改
  session/ (path/media/archive-cleanup)   # 小改（thread_ts 清洗、下载 headers）
  cli/     (index/setup/daemon/status)    # 小改（token 向导、manifest 指引、文案）
manifest.yaml         # 新增：一键建 app
```

**配置面**（【建议】，继承 Piscord 键名风格）：`SLACK_BOT_TOKEN`、`SLACK_APP_TOKEN`、`TRIGGER_NAME`、`CHANNEL_POLICY`（open/open-trigger/allowlist，默认 allowlist）、`DM_POLICY`（open/allowlist/disabled，可选 pairing 后续引入）、`REPLY_IN_THREAD`（默认 true）、其余 `PI_*`/队列/保留期配置原样。

### 3.7 权限与安全模型

**Bot scopes 最小集**（【事实】scope 名称与用途见 [scopes 参考](https://docs.slack.dev/reference/scopes)；【建议】按功能取舍）：

| Scope                                                                 | 用途                                | 必需性       |
| --------------------------------------------------------------------- | ----------------------------------- | ------------ |
| `chat:write`                                                          | 发消息（含 `chat.startStream`）     | 必需         |
| `channels:history` / `groups:history` / `im:history` / `mpim:history` | 收公开/私有/DM/群 DM 消息           | 按支持面     |
| `im:read` / `im:write`                                                | DM 会话打开（`conversations.open`） | DM 功能      |
| `files:read`                                                          | 下载 `url_private` 附件             | 附件入站     |
| `files:write`                                                         | uploadV2 出站附件                   | `send` 命令  |
| `reactions:write`                                                     | busy 指示（⏳）                     | 建议         |
| `users:read`                                                          | 用户显示名（prompt 前缀）           | 建议         |
| `commands`                                                            | `/pi` slash 命令                    | 建议         |
| `app_mentions:read`                                                   | 备用（若改用 app_mention 事件）     | 可选         |
| `assistant:write`                                                     | AI apps setStatus 等                | Phase 3 可选 |
| app-level token：`connections:write`                                  | Socket Mode 连接                    | 必需         |

**Token 与凭据**（【事实】[tokens](https://docs.slack.dev/authentication/tokens)、[token rotation](https://docs.slack.dev/authentication/using-token-rotation)）：

- 两枚 token：`xoxb-`（Web API）+ `xapp-`（仅 `apps.connections.open`）。存 `config.env`（Piscord 已有同等处理；建议 chmod 600）。
- Token rotation 为 opt-in 且**开启后不可关闭**、不适用于 app-level token——【建议】自托管场景不开启，保持长效 token（与 DISCORD_BOT_TOKEN 同等待遇）。
- Socket Mode 无需 signing secret（无入站 HTTP）。

**威胁模型与缓解**（【推断】+【建议】）：

1. **能对话 = 能驱动本机 pi（拥有本机文件系统与 shell 权限）**——最大风险面。缓解：`CHANNEL_POLICY` 默认 allowlist；DM 默认关闭或 allowlist（OpenClaw 的 pairing 配对码是好范本，可后续引入）；README 显著警示。
2. **Prompt injection**：频道内他人消息、附件内容都会进入 pi 上下文；Claude Code in Slack 官方文档同样明确警示此风险。缓解：触发门控（open-trigger/mention）、注册制、文档警示；不自动拉取频道历史（也顺带规避 history 限流）。
3. **回环/自触发**：必须过滤 `bot_id`/`subtype: bot_message`/自身 user id；跨 bot 循环（两个 bot 互相触发）通过 bot 消息一律不入队规避（与 Piscord 忽略 `author.bot` 同构）。
4. **多实例事件瓜分**：Socket Mode 负载均衡投递，误开两个实例会静默瓜分事件、打乱 `--continue` 会话连续性。缓解：文档显著警告 + 守护进程单实例（systemd/launchd 天然单例）+ 可选 DB 锁哨兵。
5. **合规**（【事实】[ToS 更新](https://docs.slack.dev/changelog/2025/05/29/tos-updates/)）：本项目开源、自托管、用户自建 app、不商业分发、不用 API 数据训练模型——与 2025 新 ToS 完全兼容；免费 workspace 限制（10 个 app、90 天历史）对目标用户基本无碍。

### 3.8 部署与运维

- 【建议】完整复用 Piscord 方案:`piscord daemon` 对应的 systemd user unit / launchd plist 生成器（`src/cli/daemon.ts`）平移，仅改服务名与文案;单进程单连接即可（无需用满 10 连接配额）。
- 【事实】断线重连由 `@slack/socket-mode` 内置（disconnect 三类：`warning`/`refresh_requested`/`link_disabled`；wss URL 为临时票据需重新换取）——SDK 兜底 + SQLite 队列保证"已接收必处理"。
- 【建议】`status` 诊断命令增加：`auth.test` 连通性、app token 有效性、事件订阅自检提示;启动日志打印 bot user、team、连接模式（对应现有 `getBotTag` 日志位）。
- 【建议】出站节流：sendResponse 内部按 channel 做 ~1 msg/s 排队（分片消息逐条发送天然接近该速率,补一个简单 per-channel 间隔即可）。
- 【推断】掉线窗口内的消息会丢（Socket Mode 无补投）。个人网关场景可接受;若要补漏,internal app 不受 1 req/min history 限流约束,可在重连后拉 `conversations.history` 补队列——列为 Phase 3 可选项,默认不做（保持"不拉历史"的安全姿态）。

### 3.9 迁移步骤与分阶段实施计划

**迁移步骤（新仓库初始化）**（【建议】）：

1. 以 Piscord 当前 main 为基底 fork/复制出新仓库,保留 git 历史（便于回溯上游修复）;改名 package/bin/服务名。
2. 删除 `src/discord/`,落地 3.6 的目录结构与 `PlatformAdapter` 接口;`attachments.ts` 移至 `src/platform/`。
3. `types.ts` 收编 `AttachmentMeta`,`agent/invoke.ts:3`、`session/media.ts:14` 改 import;`agent/queue.ts:22` 改指向 `slack/client.js`（或注入 adapter）。
4. `cli/index.ts:652` `toDiscordChannelJid` → `toSlackChannelJid`（`sl:` 前缀）;`config.ts` 换 token 键并加 `xoxb-`/`xapp-` 前缀校验;`setup.ts` 向导改为"从 manifest 建 app → 取两枚 token"流程。
5. 写 `manifest.yaml` 与 README（安装、建 app、邀请 bot、策略与安全章节）。
6. CI workflow（lint/build/test/pack、tag 发布）原样复用。

**分阶段实施**（【建议】,工作量为单人估算）：

| 阶段                               | 内容                                                                                                                                                                                        | 验收标准                                                                     | 估时     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| **Phase 0 骨架**                   | fork 改名、manifest.yaml、Bolt Socket Mode echo spike                                                                                                                                       | 本机守护进程连上 workspace,DM 收发回显                                       | 0.5-1 天 |
| **Phase 1 MVP**                    | `slack/client.ts` 完整入站归一化（防回环/mention 归一化/附件 Bearer 下载/策略注册）+ 队列接线 + `sendResponse`（markdown_text、4k 分片、线程内回帖、限速）+ reactions busy 指示 + jid `sl:` | DM 与频道 @mention → pi 会话连续多轮;崩溃重启后 pending 恢复;附件图片可达 pi | 2-4 天   |
| **Phase 2 对齐 Piscord**           | `/pi` 全子命令（status/model/models/reset-model/thinking/new/stop）、files.uploadV2、`send` CLI、scheduler 验证、setup 向导、daemon、status 诊断、README/CHANGELOG                          | 功能面与 Piscord README 对等（除 Discord 特有项）;跨平台安装脚本可用         | 3-5 天   |
| **Phase 3 Slack 原生增强（可选）** | thread_ts 派生子会话、`chat.startStream` 流式、`setStatus`/agent_view（付费 workspace 可选）、Block Kit 模型选择器、重连 history 补漏、DM pairing、空闲会话轮换                             | 各项独立开关,默认关闭不影响免费 workspace                                    | 持续迭代 |

【推断】总量:新写/重写约 1,200-1,500 行,复用约 4,000 行;MVP 一周内、对齐两周内可交付（兼职节奏）。

---

## 4. Risks / Unknowns

**风险（按影响排序）**：

1. **Bolt 停更风险**【事实基础】：4.7.3 后 13 个月无 release,且未封装 2026-06 的 `agent_view`。缓解：平台层薄封装、可降级裸 SDK、新特性直调 Web API。
2. **Socket Mode 掉线不补投**【事实】：队列只保护"已接收"。缓解：SDK 自动重连 + 可选 history 补漏（internal app 豁免限流）;个人场景影响有限。
3. **多实例静默瓜分事件**【事实】：对 `--continue` 会话连续性是灾难性 bug。缓解：文档警告 + 单实例守护。
4. **付费墙**【事实】：setStatus/流式/agent 面板等 AI 特性部分需付费计划。缓解：核心链路只用普通消息,增强特性可选。
5. **官方挤压**【推断】：Claude Tag（2026-06）、Codex 等云端团队产品持续进化;自托管+本机工作区+多 provider 是差异化,但需在 README 讲清定位。
6. **平台变更节奏**【事实】：2025-2026 Slack 密集改版（ToS、限流、agent_view、files.upload 关闭）。缓解："每用户自建 internal app"是受冲击最小的形态;锁定 Web API 直调能力。
7. **消息长度口径不一**【事实】：postMessage 40,000 截断 vs chat.update 4,000 报错。已按 4,000 取严设计。

**Unknowns（信息缺口）**：

- 线程内 @bot 是否触发 `app_mention` 事件,官方参考页未明确（本方案订阅 message 族,已规避该依赖）。
- Bolt 4.7.3 对 `markdown_text`、`chat.startStream` 的封装完整度未逐一验证——Phase 0 spike 需实测,必要时直调 `@slack/web-api`。
- Slack Developer Program 沙箱的具体限额页面未成功抓取（不影响架构,只影响开发体验文档）。
- `chat.update` 编辑窗口受 workspace 设置影响（`edit_window_closed`）,流式/占位更新方案在受限 workspace 的行为需实测。
- OpenClaw 的 `dmPolicy: pairing` 配对码具体交互细节未逐行核对源码,引入时需再确认。

---

## 5. References

**Slack 官方（检索 2026-07-11）**

- Events API：https://docs.slack.dev/apis/events-api/
- Socket Mode:https://docs.slack.dev/apis/events-api/using-socket-mode ・ apps.connections.open:https://docs.slack.dev/reference/methods/apps.connections.open
- 限流总览:https://docs.slack.dev/apis/web-api/rate-limits ・ 非 Marketplace 限流变更:https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/ ・ 澄清:https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/ ・ FAQ:https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq
- ToS 更新:https://docs.slack.dev/changelog/2025/05/29/tos-updates/ (报道:https://www.computerworld.com/article/4005509/salesforce-changes-slack-api-terms-to-block-bulk-data-access-for-llms.html )
- chat.postMessage（markdown_text/长度）:https://docs.slack.dev/reference/methods/chat.postMessage ・ chat.update:https://docs.slack.dev/reference/methods/chat.update ・ chat.startStream:https://docs.slack.dev/reference/methods/chat.startStream
- 文件上传:https://docs.slack.dev/reference/methods/files.completeUploadExternal ・ files.upload sunset:https://docs.slack.dev/reference/methods/files.upload
- AI apps:https://docs.slack.dev/ai/developing-ai-apps ・ Bolt AI 概念:https://docs.slack.dev/tools/bolt-js/concepts/ai-apps
- scopes:https://docs.slack.dev/reference/scopes ・ tokens:https://docs.slack.dev/authentication/tokens ・ token rotation:https://docs.slack.dev/authentication/using-token-rotation
- App Manifest:https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests ・ Slack CLI:https://docs.slack.dev/tools/slack-cli/
- message 事件:https://docs.slack.dev/reference/events/message ・ conversations.open:https://docs.slack.dev/reference/methods/conversations.open
- Bolt releases:https://github.com/slackapi/bolt-js/releases ・ 免费版限制:https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces
- Coding agents in Slack（官方博客）:https://slack.com/blog/developers/coding-agents-in-slack

**开源对标**

- OpenClaw:https://github.com/openclaw/openclaw ・ Slack 渠道文档:https://docs.openclaw.ai/channels/slack ・ 会话概念:https://docs.openclaw.ai/concepts/session
- NanoClaw:https://github.com/qwibitai/nanoclaw ・ nanoclaw-slack:https://github.com/qwibitai/nanoclaw-slack ・ Slack skill:https://nanoclaw.dev/skills/slack/
- cc-connect:https://github.com/chenhg5/cc-connect ・ cc-slack:https://github.com/yuya-takeyama/cc-slack ・ claude-code-slack-bot:https://github.com/mpociot/claude-code-slack-bot ・ slack-claude-agent:https://github.com/acip/slack-claude-agent ・ claude-slack-bridge:https://github.com/nariakiiwatani/claude-slack-bridge ・ aimaestro-slack-bridge:https://github.com/23blocks-OS/aimaestro-slack-bridge
- Claude Code in Slack:https://code.claude.com/docs/en/slack ・ Claude Tag:https://www.anthropic.com/news/introducing-claude-tag (报道:https://techcrunch.com/2026/06/23/anthropics-claude-tag-is-learning-your-company-one-slack-message-at-a-time/ )
- Codex in Slack:https://developers.openai.com/codex/integrations/slack ・ Copilot coding agent in Slack:https://github.blog/changelog/2025-10-28-work-with-copilot-coding-agent-in-slack/
- pi:https://github.com/badlogic/pi-mono ・ pi-chat:https://github.com/earendil-works/pi-chat ・ pi-telegram:https://github.com/badlogic/pi-telegram ・ channel 抽象 issue #1253:https://github.com/badlogic/pi-mono/issues/1253
- hubot-slack（已归档）:https://github.com/slackapi/hubot-slack ・ slack-machine:https://github.com/DonDebonair/slack-machine ・ matterbridge:https://github.com/42wim/matterbridge

**Vercel 生态**

- ai-sdk-slackbot:https://github.com/vercel-labs/ai-sdk-slackbot ・ @vercel/slack-bolt:https://vercel.com/changelog/build-slack-agents-with-vercel-slack-bolt ・ https://github.com/vercel-labs/slack-bolt
- Chat SDK（vercel/chat）:https://github.com/vercel/chat ・ 文档:https://chat-sdk.dev ・ Slack adapter:https://chat-sdk.dev/adapters/official/slack ・ Discord adapter:https://chat-sdk.dev/adapters/official/discord
- AI SDK Harnesses:https://ai-sdk.dev/docs/ai-sdk-harnesses/overview ・ pi harness:https://ai-sdk.dev/providers/ai-sdk-harnesses/pi ・ changelog:https://vercel.com/changelog/program-agent-harnesses-with-ai-sdk
- Workflows:https://vercel.com/docs/workflows ・ Sandbox:https://vercel.com/docs/vercel-sandbox ・ Functions 限制:https://vercel.com/docs/functions/limitations
- Chat SDK + AI SDK Slack 指南:https://vercel.com/kb/guide/how-to-build-an-ai-agent-for-slack-with-chat-sdk-and-ai-sdk ・ Vercel Connect:https://vercel.com/kb/guide/build-a-slack-bot-with-vercel-connect

**本仓库源码（v1.6.1,读取于 2026-07-11）**

- 耦合点:`src/agent/queue.ts:22`、`src/agent/invoke.ts:3`、`src/session/media.ts:14`、`src/index.ts:4`、`src/cli/index.ts:652`
- 关键模块:`src/db.ts`（队列/恢复）、`src/agent/invoke.ts`（pi 子进程）、`src/discord/client.ts`（入站归一化范本）、`src/session/media.ts`（附件下载,Slack 需加 Bearer 头）、`src/cli/daemon.ts`（systemd/launchd）
