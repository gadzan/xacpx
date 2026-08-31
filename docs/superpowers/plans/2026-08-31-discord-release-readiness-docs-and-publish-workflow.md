# Discord 发布前文档 + 自动 npm 发布 Workflow 实现计划

> **For agentic workers:** 按任务顺序执行。每个任务先确认当前仓库事实，再改文件，再跑聚焦验证。只实现本文范围；**不要实现 ACP/Discord 权限交互、Buttons/Components、Runtime permission broker，也不要引入 PR #312 的 RuntimeEngine 依赖。**
>
> **目标 PR:** `gadzan/xacpx#316` (`feat/channel-discord`)
>
> **计划编写基准 head:** `a2de4265ea81fea12d96f7d26141bb6384948bb8`
>
> **目标:** 在 PR #316 内补齐 Discord 首次公开发布前的两个 release-readiness 缺口：
>
> 1. `@ganglion/xacpx-channel-discord` 的 tag 驱动 npm 自动发布 + GitHub Release Workflow；
> 2. 面向用户的完整 Discord 安装、Bot 创建/邀请、xacpx 配置、allowlist、安全默认、首次验证、升级与排错文档。

---

## 0. 范围定案

### 0.1 本轮做什么

```text
A. 自动发布
   channel-discord-vX.Y.Z tag
        ↓
   GitHub Actions
        ↓
   npm publish
        ↓
   GitHub Release

B. 用户文档
   安装插件
        ↓
   Discord Developer Portal 创建 Application/Bot
        ↓
   获取 Bot Token + 开 Message Content Intent
        ↓
   邀请 Bot 到 Server
        ↓
   获取 User/Guild/Channel/Role ID（按需）
        ↓
   xacpx channel add discord
        ↓
   配 allowlist / requireMention
        ↓
   restart / show / doctor
        ↓
   首次 DM / @bot / /help / /ss 验证
        ↓
   upgrade / troubleshooting
```

### 0.2 本轮明确不做

- 不实现 Discord permission buttons / interactions。
- 不改 `DiscordClientLike` 增加 `interactionCreate`。
- 不改 acpx Runtime / Bridge / PromptOptions permission API。
- 不实现真正的 Discord REST `doctor --deep` live probe；文档必须准确描述**当前已有**诊断能力。
- 不改变 Discord 当前安全默认：`dmPolicy=allowlist`、`guildPolicy=allowlist`、`requireMention=true`。
- 不为了“让 quick start 一条命令就通”把默认策略放宽成 `open`。
- 不新增 Discord slash commands / modal / application commands。
- 不修改现有 consumer-lock、streaming、chunking、media runtime 逻辑。

权限交互另立后续计划。本轮只把 #316 做到“用户能正确安装、正确配置、正确验证、能发布”。

---

# 1. Discovery：当前仓库事实

执行 Agent 开工前先重新读取以下文件；若仓库已经前进，以当前 HEAD 为准，但保持本文语义。

## 1.1 Discord README 已有最短命令，但不完整

当前：

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord --token <bot-token>
xacpx restart
```

并提到 Developer Portal 和 Message Content Intent。

缺少：

- 从 New Application / Bot 开始的创建步骤；
- Bot 安装/邀请到 server 的步骤；
- Developer Mode + ID 获取；
- 默认 allowlist 导致“bot 在线但消息没反应”的解释；
- 首次成功验证闭环；
- 升级/卸载；
- 系统化 troubleshooting；
- multi-account CLI 例子；
- 对 `applicationId` 的准确说明；
- 与 `docs/channel-management.md` 的正式入口链接。

## 1.2 Discord 不是 login/pairing channel

`packages/channel-discord/src/discord-provider.ts`：

```ts
supportsLogin: false
```

因此文档不要把 Discord 描述成微信式“配对/登录”。准确模型是：

> **Bot token credential configuration + Discord server installation + Gateway connection**

用户语言可写成“安装和配置 Discord Bot”，不写“扫码配对”。

## 1.3 当前默认配置是安全默认，不是开箱全放行

`discordCliProvider.buildDefaultConfig()` 当前默认：

```text
replyMode    = auto
requireMention = true
dmPolicy     = allowlist
guildPolicy  = allowlist
```

而 `allowFrom` 默认为空。

`evaluateDiscordAccessPolicy()` 在 `allowlist + []` 下会拒绝 sender。

这意味着只执行：

```bash
xacpx channel add discord --token ...
```

**不等于“马上可以发消息”。** Bot 可以成功登录 Gateway，但 DM / guild sender 如果没进入 allowlist，会被安全策略挡住。

文档必须把这一点写清楚，否则用户最容易误判为插件损坏。

## 1.4 `Message Content Intent` 默认在 xacpx 配置侧视为 enabled

`parseIntents()` 默认：

```ts
{ messageContent: true, guildMembers: false }
```

但 Discord Developer Portal 端仍必须允许 Message Content Intent，否则 guild message content 可能拿不到。

README 要区分两层：

```text
Discord Portal capability
vs
xacpx options.intents.messageContent
```

不要把“本地配置 true”写成“Portal 已经启用”。

## 1.5 当前 diagnose 是 shallow config check

`discordCliProvider.diagnose()` 当前检查：

- token 是否缺失；
- `intents.messageContent === false` 的本地配置 warning；
- token 是否异常短；
- 无问题时返回：
  `Discord config looks OK (shallow check; run with --deep for live probe)`。

但 Discord provider 当前没有在这里实现 `/users/@me` REST live probe。

因此本轮文档必须：

- **不要承诺现有 `plugin doctor --deep` 会验证 Discord token/live Gateway**，除非执行 Agent 在当前 HEAD 发现 core 的另一路径确实替 provider 完成了 live probe；
- 若没有，README 里应改成“doctor 做配置诊断；最终 live 验证以 daemon 启动日志 / bot online / 实际消息 roundtrip 为准”。

本轮不为了修文档而新增 REST probe。

## 1.6 正式 channel management 文档尚未纳入 Discord

需要同步：

- `README.md`
- `docs/zh/README_zh.md`
- `docs/channel-management.md`
- `docs/zh/channel-management_zh.md`
- `packages/channel-discord/README.md`

至少这五处形成入口闭环。

## 1.7 自动发布已有成熟先例

直接以：

- `.github/workflows/publish-channel-feishu.yml`
- `.github/workflows/publish-channel-yuanbao.yml`

为模板。

现有 first-party plugin contract：

```text
push channel-<name>-v* tag
or workflow_dispatch(existing tag)
→ checkout exact tag
→ setup bun/node
→ npm ci
→ npm test
→ build package
→ verify:publish
→ read package version
→ verify tag == package version
→ prerelease => npm next
   stable     => npm latest
→ npm publish
→ GitHub Release
```

Discord 不另造发布协议，只替换 package/tag/build/name。

---

# 2. 文档产品语义

## 2.1 Quick Start 必须安全但真的可走通

不建议把默认 policy 改成 `open`。

README 应给用户两条清晰路径：

### 推荐：个人安全配置

先添加 channel：

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord --token '<BOT_TOKEN>'
```

然后把自己的 Discord User ID 加入 allowlist。

由于当前 `channel add discord` CLI **没有 `--allow-from` flag**，文档必须诚实说明：

> 当前 allowlist 需要编辑 `~/.xacpx/config.json` 的 `channels[].options.allowFrom`（或对应 `accounts.<id>.allowFrom`）。

示例：

```jsonc
{
  "id": "discord",
  "type": "discord",
  "enabled": true,
  "options": {
    "token": "...",
    "dmPolicy": "allowlist",
    "guildPolicy": "allowlist",
    "allowFrom": ["YOUR_DISCORD_USER_ID"],
    "requireMention": true
  }
}
```

然后：

```bash
xacpx restart
```

这是首选 onboarding。

### 临时 smoke test：显式 open

可以提供：

```bash
xacpx channel add discord \
  --token '<BOT_TOKEN>' \
  --dm-policy open \
  --guild-policy open \
  --require-mention true
```

但必须紧跟警告：

> `open` 适合受控测试 server / 临时验证，不是推荐长期安全配置。尤其不要在公开 server 上同时使用 `guildPolicy=open` + `requireMention=false`。

这样既不弱化默认安全边界，也给用户一个确认 Gateway/消息链路是否工作的快速排障手段。

## 2.2 Token 文档不要假设固定前缀

当前 README 有类似：

```text
The bot token is a Discord Bot token (`MT...`).
```

删除 `MT...` 这种格式暗示。

改成：

> Use the Bot Token shown/reset under the application’s Bot settings. Treat it as a secret; do not paste it into issues, logs, screenshots, or chat.

原因：当前实现本身已经明确不拿 token regex 做硬门禁；文档也不要反向写死 token 代际形状。

## 2.3 Bot Token 是 secret

文档至少写：

- 推荐运行不带 `--token` 的交互命令，让 CLI `promptSecret()` 输入，减少 shell history 暴露；
- 若使用 `--token`，注意 shell history / CI logs；
- token 泄漏后去 Developer Portal Rotate/Reset，再更新 xacpx 配置并 restart；
- `channel show`/summary 会 mask token，不应打印明文。

推荐 quick start 优先：

```bash
xacpx channel add discord
```

然后：

```text
Discord bot token:
```

参数式命令保留给自动化。

## 2.4 Discord Developer Portal 步骤写“稳定概念”，不要依赖易变 UI 文案

建议 README/完整文档描述：

1. 打开 Discord Developer Portal；
2. 创建 Application；
3. 在 Bot 设置创建/确认 bot user；
4. Reset/Copy Bot Token；
5. 启用 Message Content privileged intent；
6. 在 Installation / OAuth2 生成 server-install 授权入口，把 app/bot 添加到目标 server；
7. 不授予 Administrator，按需要给最小权限。

Portal 页面名称可能变化，文档写：

> Discord may rename Portal sections; use the current Developer Portal as the source of truth.

### 建议最小 guild channel permissions

按当前 Discord plugin 实际能力给出推荐集合：

```text
View Channels
Send Messages
Read Message History
Add Reactions
Attach Files
Send Messages in Threads   # 如果使用 threads / forum posts
```

说明：

- `Read Message History` 对 reply/reaction 等操作有用；
- `Send Messages in Threads` 是 thread 单独权限，普通 `Send Messages` 不替代它；
- 不需要 Administrator；
- 不要求 Manage Messages，因为插件只删除/编辑自己的 preview message，不需要删他人消息；
- 如果某功能不用（例如附件），可进一步收紧权限。

实现 Agent 在最终写文档时应对照 Discord 当前官方 permission 名称再确认一遍，但不要扩大权限。

## 2.5 Developer Mode + Snowflake 获取必须写

因为安全配置需要 ID，文档增加：

```text
Discord Settings → Advanced → Developer Mode
```

然后说明可通过 Copy ID 获取：

- User ID → `allowFrom` / guild users；
- Server/Guild ID → `guilds.<guildId>`；
- Role ID → `guilds.<guildId>.roles`；
- Channel ID → `guilds.<guildId>.channels`；
- Thread ID 本身由插件运行时自动路由，普通用户通常不需要手填。

不要要求用户填 username/display name；policy 比较的是 Discord snowflake ID。

## 2.6 `applicationId` 的文档处理

当前 CLI 暴露 `--application-id`，配置也支持 `applicationId`，但当前 message-only Gateway 主链并不需要用户为了基本收发强制填写它。

文档应写成：

> `applicationId` is optional for the current message-channel flow. The Bot Token is the required credential. If future Discord interaction/application-command features require the Application ID, it can be stored now with `--application-id`, but basic message routing does not require it.

如果执行 Agent 在当前 HEAD 发现 `applicationId` 已经被 runtime 强制消费，则以实现为准修正；不要凭想象写成 required。

## 2.7 “配对成功”的验收定义

文档不要只写“bot online”。完整成功闭环：

```text
1. xacpx plugin is installed
2. discord channel config exists and is enabled
3. daemon starts Discord account successfully
4. bot appears online / connected in Discord
5. allowed sender sends DM or @mentions bot in allowed guild/channel
6. /help returns
7. /ss codex -d /absolute/path/to/repo succeeds
8. plain text reaches current agent session and receives reply
```

任何一步失败都能对应到 troubleshooting。

---

# 3. 最终文档结构

## 3.1 `packages/channel-discord/README.md` — Discord 专用、10 分钟 onboarding

建议重构为：

```markdown
# @ganglion/xacpx-channel-discord

## Quick start
### 1. Install the plugin
### 2. Create a Discord application and bot
### 3. Enable Message Content Intent
### 4. Install the bot into your server
### 5. Enable Developer Mode and copy your User ID
### 6. Add the Discord channel to xacpx
### 7. Configure access policy / allowlist
### 8. Restart and verify

## Security defaults
## Configuration
## Multiple accounts
## Reply modes
## Threads and chatKey
## Media
## Consumer lock
## Updating / removing
## Troubleshooting
```

把当前已有 Configuration / Reply modes / Tables / ChatKey / Multiple accounts / Consumer lock / Security 内容保留并重排，不要丢行为细节。

### Quick Start 推荐命令

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord
# secret prompt: Discord bot token
```

然后明确给出 allowlist JSON。

验证：

```bash
xacpx channel show discord
xacpx plugin doctor
xacpx restart
```

Discord 里：

```text
@your-bot /help
@your-bot /ss codex -d /absolute/path/to/repo
@your-bot hello
```

DM 不需要 mention，但仍受 `dmPolicy` / allowlist 控制。

### Troubleshooting 至少覆盖

| Symptom | Likely cause | Action |
|---|---|---|
| Bot offline | daemon/channel startup/token | check `xacpx status`, restart, runtime log, rotate token if invalid |
| Bot online but DM ignored | `dmPolicy=allowlist` + sender not in `allowFrom` | add User ID or explicitly set open for testing |
| Bot online but server message ignored | guild allowlist or `requireMention=true` | add sender/role; @mention bot |
| Bot sees events but content empty | Message Content Intent | enable in Developer Portal; keep local intent enabled |
| Thread can read but cannot reply | missing `Send Messages in Threads` | grant channel/server permission |
| Attachments fail | Discord permission or xacpx `media.maxBytes` | grant Attach Files / check local limit |
| second xacpx process fails to start Discord | per-token consumer lock | stop duplicate process or use distinct bot token |
| two accounts share token | config validation | give each enabled account its own token |
| replies never trigger without mention | expected `requireMention=true` | mention bot or configure channel override |

不要声称 `plugin doctor --deep` 已经验证 token，除非代码真实实现。

## 3.2 `docs/channel-management.md` — 正式完整 Discord Channel 章节

在 Feishu / Yuanbao 同级增加：

```markdown
## Discord Channel Plugin

### 1. Install the plugin
### 2. Create and configure the Discord bot
### 3. Install bot into a server
### 4. Add the channel
### 5. Configure safe access
### 6. Restart and verify
### 7. Discord multi-account
### 8. Updating / disabling / removing
### 9. Troubleshooting
```

这里比 package README 更强调 xacpx channel management 命令：

```bash
xacpx channel show discord
xacpx channel disable discord
xacpx channel enable discord
xacpx channel rm discord
xacpx plugin update @ganglion/xacpx-channel-discord
xacpx restart
```

Multi-account 例子：

```bash
xacpx channel add discord --account main --token '<TOKEN_A>'
xacpx channel add discord --account ops  --token '<TOKEN_B>'
xacpx channel show discord --account main
xacpx channel disable discord --account ops
xacpx channel enable  discord --account ops
xacpx channel rm      discord --account ops
```

注意当前 provider 支持的 flags 只按实际 `parseAddArgs()` 写，不要文档化不存在的 flag。

### 文档顶端列表也更新

插件列表加入：

```text
- discord: @ganglion/xacpx-channel-discord, Discord Bot Token + Gateway
```

“当前 type 示例”加入 `discord`。

## 3.3 `docs/zh/channel-management_zh.md`

与英文文档语义同步，不做缩水版。

重点中文解释：

- Discord 不是扫码登录；
- token 是机器人 secret；
- 默认 allowlist 是故意的安全边界；
- Developer Mode 是为了复制 snowflake ID；
- `requireMention=true` 是服务器默认；
- “机器人在线但不回复”优先查 allowlist 和 mention，而不是先重装插件。

## 3.4 根 `README.md`

只做入口级更新，不复制完整 Discord 教程。

修改：

- tagline：`WeChat, Feishu, Yuanbao, or Discord`；
- What is this；
- prerequisites；
- Other channels；
- chat command surface 文案；
- channel add cheat-sheet 的例子。

Other channels 增加：

```bash
# Discord
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord     # enter Bot Token when prompted
xacpx restart
```

紧跟一句：

> Discord defaults to allowlist access; complete the User ID allowlist step in `docs/channel-management.md` before expecting messages to be handled.

避免 quick start 误导。

## 3.5 `docs/zh/README_zh.md`

与根 README 对等加入 Discord。

---

# 4. Task 1 — 新增 Discord 自动发布 Workflow

**Files:**

- Create: `.github/workflows/publish-channel-discord.yml`

### Step 1: 读取两个模板

```bash
command cat .github/workflows/publish-channel-feishu.yml
command cat .github/workflows/publish-channel-yuanbao.yml
command cat packages/channel-discord/package.json
command grep -n 'build:channel-discord\|verify:publish' package.json
```

确认：

- package name = `@ganglion/xacpx-channel-discord`；
- package version 当前为 `0.8.0`（若 HEAD 已变化，以实际为准）；
- root 存在 `build:channel-discord`；
- `verify:publish` 已覆盖 package artifact 检查。

### Step 2: 创建 workflow

推荐内容直接按现有 first-party 模板替换名字：

```yaml
name: Publish @ganglion/xacpx-channel-discord

on:
  push:
    tags:
      - "channel-discord-v*"
  workflow_dispatch:
    inputs:
      tag:
        description: 'Existing tag to publish (e.g. channel-discord-v0.8.0-beta.0). Must already exist on the repo.'
        required: true
        type: string

permissions:
  contents: write

concurrency:
  group: publish-channel-discord-${{ github.ref }}
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        shell: bash
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          ref: ${{ inputs.tag || github.ref }}
          fetch-depth: 0

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org/
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Build channel-discord (and plugin-api types)
        run: bun run build:channel-discord

      - name: Verify publishable artifacts
        run: bun run verify:publish

      - name: Read version
        id: meta
        run: |
          VERSION="$(node -p "require('./packages/channel-discord/package.json').version")"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          if [[ "$VERSION" == *-* ]]; then
            echo "prerelease=true" >> "$GITHUB_OUTPUT"
            echo "npm_tag=next" >> "$GITHUB_OUTPUT"
          else
            echo "prerelease=false" >> "$GITHUB_OUTPUT"
            echo "npm_tag=latest" >> "$GITHUB_OUTPUT"
          fi

      - name: Verify tag matches package version
        run: |
          if [[ -n "${{ inputs.tag }}" ]]; then
            TAG_NAME="${{ inputs.tag }}"
          else
            TAG_NAME="${GITHUB_REF#refs/tags/}"
          fi
          EXPECTED="channel-discord-v${{ steps.meta.outputs.version }}"
          if [[ "$TAG_NAME" != "$EXPECTED" ]]; then
            echo "::error::tag $TAG_NAME does not match package.json version ($EXPECTED)" >&2
            exit 1
          fi
          echo "tag_name=$TAG_NAME" >> "$GITHUB_ENV"

      - name: Publish to npm
        working-directory: packages/channel-discord
        run: npm publish --tag ${{ steps.meta.outputs.npm_tag }} --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if gh release view "$tag_name" >/dev/null 2>&1; then
            echo "Release $tag_name already exists, skipping create"
            exit 0
          fi
          TITLE="@ganglion/xacpx-channel-discord v${{ steps.meta.outputs.version }}"
          if [[ "${{ steps.meta.outputs.prerelease }}" == "true" ]]; then
            gh release create "$tag_name" --title "$TITLE" --prerelease --generate-notes
          else
            gh release create "$tag_name" --title "$TITLE" --latest=false --generate-notes
          fi
```

### Step 3: 不要“顺手优化”其他 workflow

本 PR 不统一 Feishu/Yuanbao package naming，不升级 action versions，不重构 shared reusable workflow。

目标是新增 Discord 同级流程，diff 越小越容易审。

### Step 4: 本地验证

```bash
npm ci --dry-run
bun run build:channel-discord
bun run verify:publish
npm test
```

若本机装有 `actionlint`：

```bash
actionlint .github/workflows/publish-channel-discord.yml
```

没有就不要为此加依赖。

### Step 5: 静态人工检查

必须人工核对 8 个字符串全部是 Discord：

```text
workflow display name
push tag pattern
workflow_dispatch example tag
concurrency group
build command
package.json read path
expected tag prefix
working-directory / GitHub Release title
```

### Step 6: Commit 建议

```bash
git add .github/workflows/publish-channel-discord.yml
git diff --cached --check
git diff --cached
git commit -m "ci(channel-discord): add npm publish workflow"
```

---

# 5. Task 2 — 重写 Discord package README onboarding

**Files:**

- Modify: `packages/channel-discord/README.md`

### Step 1: 保留已有技术行为章节

先把当前 README 内容完整读一遍。

必须保留：

- Configuration shape；
- Guild allowlist note；
- Reply modes；
- Tables；
- ChatKey；
- Threads independent session；
- Multiple accounts + duplicate-token invariant；
- Consumer lock；
- allowed mentions security；
- media root validation；
- Commands。

本任务是**补 onboarding + 重排**，不是删技术文档。

### Step 2: 新增完整 Quick Start

按 §3.1 结构实现。

必须出现：

```text
Create Application/Bot
Bot Token secret handling
Message Content Intent
Install bot into server
minimal permissions
Developer Mode
Copy User ID
xacpx plugin add
xacpx channel add
allowFrom
restart
channel show
plugin doctor
/help
/ss
plain-text roundtrip
```

### Step 3: 修正文档不准确项

至少修：

1. 删除固定 token prefix `MT...`；
2. 不把 `plugin doctor --deep` 写成已实现的 live REST probe；
3. 明确默认 allowlist empty 会拒绝用户；
4. 明确 `applicationId` 对当前 basic message flow 是 optional（除非当前 HEAD 代码已经改变）；
5. 明确 Discord `supportsLogin=false`，没有 `xacpx login discord` 之类流程。

### Step 4: 增加升级/删除

```bash
xacpx plugin update @ganglion/xacpx-channel-discord
xacpx restart

xacpx channel disable discord
xacpx channel enable discord
xacpx channel rm discord
```

若 `plugin update` 的 CLI 真实语法与当前仓库不同，以 `docs/plugin-development` / CLI 实现为准，不猜。

### Step 5: 增加 troubleshooting table

至少覆盖 §3.1 表格场景。

### Step 6: 验证所有命令真实存在

逐一搜索 CLI/provider：

```bash
command grep -rn "plugin update" src docs | command cat
command grep -rn "channel add" src/commands src/cli* docs | command cat
command cat packages/channel-discord/src/discord-provider.ts
```

文档 flag 只允许来自 `parseAddArgs()`：

```text
--token
--application-id
--reply-mode
--table-mode
--require-mention
--dm-policy
--guild-policy
```

以及 core 通用 `--account` / restart flags（先确认 core 确实支持后再写）。

### Step 7: Commit 建议

```bash
git add packages/channel-discord/README.md
git diff --cached --check
git commit -m "docs(channel-discord): add complete setup guide"
```

---

# 6. Task 3 — 正式 channel-management 英文文档接入 Discord

**Files:**

- Modify: `docs/channel-management.md`

### Step 1: 顶部 channel 列表加入 Discord

增加：

```text
discord — @ganglion/xacpx-channel-discord — Discord Bot Token / Gateway
```

同时修：

```text
examples: weixin, feishu, yuanbao, discord
```

### Step 2: 新增完整 `## Discord Channel Plugin`

按 §3.2 结构。

这里不要把 package README 全复制一遍，但必须足够让没读 package README 的用户独立完成安装。

### Step 3: 写清“没有 pairing/login”

对比：

```text
WeChat → QR login
Feishu/Yuanbao → platform credentials
Discord → Bot token + server installation + Gateway
```

### Step 4: 多账号管理

只写当前 core/provider 真支持的 `--account` 语义。

强调：

```text
each enabled account must resolve to a unique Bot Token
```

### Step 5: 故障排查

把 Discord 特有场景写在 Discord 章节，不要只扔进全局 troubleshooting。

### Step 6: Commit 建议

与中文 Task 4 可以一起 commit；如果分开：

```bash
git add docs/channel-management.md
git diff --cached --check
git commit -m "docs: document Discord channel setup"
```

---

# 7. Task 4 — 中文 channel-management 对等更新

**Files:**

- Modify: `docs/zh/channel-management_zh.md`

要求：

- 不是英文文档的缩水摘要；
- 命令、默认值、风险警告、multi-account、troubleshooting 与英文语义对齐；
- 中文自然表达，不直译 Portal 易变 UI；
- token、applicationId、allowlist、snowflake 等术语第一次出现解释。

建议标题：

```markdown
## Discord 频道插件
```

关键提示建议显眼写：

> Discord 默认 `dmPolicy=allowlist`、`guildPolicy=allowlist`。只添加 Bot Token 并不会自动授权任何 Discord 用户；如果机器人已在线但完全不回复，先检查 `allowFrom` / guild users/roles 和 `requireMention`。

Commit 可与 Task 3 合并：

```bash
git add docs/channel-management.md docs/zh/channel-management_zh.md
git diff --cached --check
git commit -m "docs: add Discord channel onboarding"
```

---

# 8. Task 5 — 根 README / 中文 README 加 Discord 入口

**Files:**

- Modify: `README.md`
- Modify: `docs/zh/README_zh.md`

### 修改范围

只做入口级：

- tagline / supported channels；
- “What is this / 这是什么”；
- prerequisites；
- “Other channels / 其它频道” 添加 Discord；
- chat surface 文案从三频道扩到 Discord；
- 链接正式 channel management 文档。

不要把完整 Bot 创建教程复制到 root README。

### 英文示例

```bash
# Discord
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord     # enter Bot Token when prompted
xacpx restart
```

随后：

```text
Discord uses safe allowlist defaults. Complete the Discord User ID allowlist step in docs/channel-management.md before expecting messages to be handled.
```

中文同义。

### Commit 建议

```bash
git add README.md docs/zh/README_zh.md
git diff --cached --check
git commit -m "docs: add Discord to channel quick start"
```

---

# 9. Task 6 — 发布说明与 Release Runbook

**Files:**

优先修改现有 release 文档；先搜索：

```bash
command find docs -maxdepth 2 -type f | command grep -Ei 'release|publish' | command cat
command grep -rn "channel-feishu-v\|channel-yuanbao-v" docs README.md | command cat
```

若已有统一发布文档，在那里追加 Discord；**不要另起重复 release guide**。

至少记录：

```text
Package: @ganglion/xacpx-channel-discord
Tag: channel-discord-v<version>
Stable -> npm latest
Prerelease -> npm next
Workflow: .github/workflows/publish-channel-discord.yml
```

### 首发 runbook

假设 package version 为 `0.8.0`：

```bash
# 1. 确认 PR merge 后 main 是目标代码
# 2. 确认 packages/channel-discord/package.json version
# 3. 确认 npm package name 无误
# 4. 创建精确 tag
git tag channel-discord-v0.8.0
git push origin channel-discord-v0.8.0

# 5. GitHub Actions 自动：tests/build/verify/publish/release
# 6. 验证 npm dist-tag 与 GitHub Release
```

不要在计划实现期间真的创建 tag / publish npm；只有用户明确要求发版时才做。

---

# 10. 文档安全约束

执行 Agent 写文档时必须遵守：

## D1 — 不泄漏 token

所有例子用：

```text
<BOT_TOKEN>
```

或明显虚构 placeholder。

不要放真实 token-looking string。

## D2 — 不推荐 Administrator

最小权限原则。

## D3 — 不把安全默认改成 open

`open` 只作为明确的临时 smoke-test 示例，并附风险说明。

## D4 — 不承诺不存在的 doctor 能力

以代码为准。

## D5 — 不把 username 当授权 identity

allowlist 用 snowflake User ID / Role ID。

## D6 — 不把 `requireMention=false` 当默认建议

公开 guild 推荐保持 true。

## D7 — 不混入权限交互未来设计

不要在当前用户文档声称：

```text
Agent permission requests appear as Discord buttons
```

因为本轮不实现。

如要提，只能放未来能力/非目标，不应出现在 usage promises。

---

# 11. 验证矩阵

完成全部文档 + workflow 后执行：

```bash
npx tsc --noEmit
bun run build:channel-discord
bun run verify:publish
npm test
git diff --check
```

文档人工验收必须逐项：

```text
[ ] root README 能发现 Discord
[ ] 中文 root README 能发现 Discord
[ ] package README 能从零创建/安装/配置/验证 Bot
[ ] 英文 channel-management 有完整 Discord 章节
[ ] 中文 channel-management 有完整 Discord 章节
[ ] 所有 CLI flags 都真实存在
[ ] 默认 allowlist 行为解释正确
[ ] Message Content Intent 两层语义解释正确
[ ] token 无固定前缀假设
[ ] applicationId 不被误写成 basic flow 必填
[ ] 不承诺未实现 live doctor probe
[ ] 不承诺未实现 permission buttons
[ ] multi-account 独立 token 规则写清
[ ] consumer-lock troubleshooting 写清
[ ] thread permission / Send Messages in Threads 写清
[ ] workflow tag prefix = channel-discord-v
[ ] workflow package = @ganglion/xacpx-channel-discord
[ ] prerelease -> next
[ ] stable -> latest
[ ] tag/version mismatch fail closed
[ ] npm working-directory = packages/channel-discord
[ ] GitHub Release title/package 名正确
```

---

# 12. 建议提交顺序

推荐 4 个小 commit，便于 review：

```text
1. ci(channel-discord): add npm publish workflow
2. docs(channel-discord): add complete setup guide
3. docs: add Discord channel onboarding
4. docs: add Discord to channel quick start
```

如果 release 文档单独更新，再加：

```text
5. docs(release): document Discord plugin publishing
```

不要 squash 到实现 Agent 完全无法审查的一个巨大 commit；最终 PR 是否 squash merge 由仓库策略决定。

---

# 13. PR #316 描述更新模板

实现完成后，PR body 增加一个独立章节，例如：

```markdown
## Release readiness — Discord onboarding + automated publishing

- Added `.github/workflows/publish-channel-discord.yml`, matching the existing first-party Feishu/Yuanbao release contract:
  `channel-discord-v*` → tests → build → verify:publish → npm (`next` for prerelease, `latest` for stable) → GitHub Release.
- Expanded `packages/channel-discord/README.md` into an end-to-end setup guide: create bot, enable Message Content Intent, install into server, minimal permissions, Developer Mode IDs, xacpx install/config, safe allowlist defaults, first-message verification, upgrade/removal, troubleshooting.
- Added full Discord sections to EN/ZH channel-management docs and Discord entry points to EN/ZH root READMEs.
- Documentation explicitly preserves the current secure defaults (`dmPolicy/guildPolicy=allowlist`, `requireMention=true`) and does not claim unimplemented live doctor or permission-interaction behavior.

Verification:
- `npx tsc --noEmit`
- `npm test`
- `bun run build:channel-discord`
- `bun run verify:publish`
- `git diff --check`
```

---

# 14. Definition of Done

本轮完成的标准不是“多了一个 README 段落”，而是：

### 用户侧

一个从未配置过 Discord Bot 的 xacpx 用户，只读仓库文档，可以完成：

```text
创建 Bot
→ 安装到 Server
→ 安全地配置 token
→ 配置自己的 allowlist
→ 启动 Discord channel
→ 判断 Bot 是否真的连上
→ 完成 /help / /ss / agent reply roundtrip
→ 知道常见“不回复”的根因
→ 知道如何升级/停用/删除
```

### 发布侧

maintainer 只需要：

```text
package version 正确
→ push channel-discord-v<version>
```

后续测试、构建、publish 校验、npm dist-tag、GitHub Release 全由 workflow 完成；tag/version 不一致则 fail closed。

达到以上两点后，PR #316 才算完成 Discord 插件首次公开发布所需的 release/documentation 闭环。
