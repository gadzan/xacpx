# 可观测性批次:统一日志 设计文档

**日期:** 2026-07-06
**来源:** 2026-07 全库架构审读「轨道1 可观测性」(见 memory `project-arch-audit-2026-07-backlog`)。

## 目标

1. 把 weixin 子系统日志从游离的模块级单例(写世界可读的 `/tmp/openclaw`)并入 DI 注入的核心 `AppLogger`(`~/.xacpx/runtime/app.log`,0o600,已有轮转)。消除排障盲区 + `/tmp` 明文隐私问题。
2. 给 relay hub 服务端(`packages/relay/src`,目前除 CLI 外零日志、多处 catch 静默吞)加最小结构化日志层。

## 范围与结构

一份 spec、两个**互不共享代码**的部分(不同包、不同进程),日志目标按各自部署模型分化——这是各自正确,不是不一致:

- **Part A — weixin → 核心 AppLogger**:后台 daemon,写文件 `~/.xacpx/runtime/app.log`。
- **Part B — relay hub 日志层**:前台进程,pm2/systemd/Docker 托管,写 **stdout/stderr 结构化行**(`pm2 logs xacpx-relay` 是文档确立的运维读日志方式;不落文件、不自做轮转)。

SDD 执行时两部分各自成任务组。两者无共享代码:relay 是独立发布包,不能 import 核心的 `src/logging/app-logger.ts`;日志格式化在 hub 侧独立重实现(约 15 行)。

## 全局约束

- **无新依赖**。两侧均不引入第三方日志库。
- **隐私红线**:任何日志都**绝不**记 token / 凭证 / 消息正文;只记 id、计数、reason、状态。
- **AppLogger 接口不改**:`debug/info/error(event, message, context?)`,3 级(error/info/debug),异步但返回的 Promise 永不 reject(可 fire-and-forget)。见 `src/logging/app-logger.ts:28`。
- weixin 测试用 `bun test <单文件>` 逐文件跑;relay 测试同理(注意 CI 在 node 下跑)。
- git 卫生:只 add 改动文件,禁止 `git add -A`;不改 lockfile;英文 conventional commits。

---

## Part A — weixin 日志并入 AppLogger

### 现状(证据)

- `src/weixin/util/logger.ts:143` `export const logger`:模块级单例,17 文件 import,同步,6 级(TRACE..FATAL 走 `OPENCLAW_LOG_LEVEL`),写死 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`(`logger.ts:11`,`mkdirSync` 默认权限 + `appendFileSync` 无 mode = 世界可读),tslog JSON 格式。
- `logger.ts:8` 注释谎称「Same file and format used by all other channels」——openclaw fork 残留,失真(feishu/yuanbao/relay 都走 AppLogger)。
- 调用面:**117 处**(42 debug / 34 error / 28 info / 13 warn),约 20 文件,绝大多数是**自由函数**(login-qr、pic-decrypt、send、api、media、cdn 等);仅 `src/weixin/monitor/monitor.ts` 用 2 次 `withAccount(id)`;**无 import 期顶层调用**(DI 安全,已 grep 核实)。

### 机制:组合根模块绑定注入

选定「组合根模块绑定」而非真参数 DI:117 处自由函数若穿参会病毒式扩散到所有上游调用者签名,爆炸半径远超收益。

- 新建 `src/weixin/util/weixin-log.ts`:
  - 导出 `weixinLog`:对象,方法 `debug/info/error(event: string, message: string, context?: Record<string, unknown>)`,fire-and-forget 转发到当前注入的 AppLogger(不 await)。
  - 导出 `setWeixinLog(logger: AppLogger): void`:设置模块内的 sink。
  - 注入前(sink 未设):调用为 **noop**(实测启动早期无 weixin 日志;若日后有,noop 丢弃可接受)。
- `src/main.ts` 的 `buildApp` 构造 AppLogger 后(约 `main.ts:180` 之后)调一次 `setWeixinLog(logger)`。

### 调用点重写(117 处)

`logger.x("msg")` → `weixinLog.x("event", "msg", { ctx })`:

- **event 命名约定**:`weixin.<area>.<动作_snake>`,area 从文件归属推导:
  - `login`(auth/login-qr、auth/accounts)、`message`(messaging/*)、`media`(media/*)、`cdn`(cdn/*)、`api`(api/*)、`monitor`(monitor/*)、`send`(messaging/send*)。
  - 动作用简短 snake_case 动词(如 `weixin.login.qr_fetch`、`weixin.message.received`、`weixin.media.download_failed`)。实现者按现有 message 文本 + 调用位置命名,力求可 grep。
- **message**:保留原有可读文本;动态 ID(accountId 等)移入 context,不过度拆解(YAGNI——不为每个插值都造字段)。
- **级别映射(6→3)**:`debug→debug`、`info→info`、`error→error`;`warn`(13 处)默认 `→ info`,逐条把语义上真正的失败提升为 `error`;代码中未使用的 `FATAL/TRACE` 顺带归 `error/debug`。
- **accountId**:`monitor.ts` 的 2 处 `logger.withAccount(id).x(...)` → `weixinLog.x("event","msg",{ accountId: id })`。

### 删除与清理

- 删除 `src/weixin/util/logger.ts` 整个文件(单例 + `setLogLevel` + `OPENCLAW_LOG_LEVEL` + `/tmp/openclaw` 写入 + `Logger` 类型 + `withAccount`/`getLogFilePath`/`close`)。
- 若有对 `setLogLevel` / `getLogFilePath` / `logger.close()` 的外部引用,一并清理(grep 核实并处理)。
- 更新 `CLAUDE.md:151`:把「运行日志:`~/.xacpx/runtime/app.log`」补充为完整位置说明(weixin 现也在此;若仍有 perf log 另注)。

### 结果

weixin 日志自此遵循 `config.logging.level`(与 app.log 统一),落 `~/.xacpx/runtime/app.log`(0o600),`/tmp/openclaw` 不再产生。

---

## Part B — relay hub 日志层

### 现状(证据)

- `packages/relay/src` 除 CLI(`cli.ts:196/199`、`cli-update.ts`)外无任何 logger/console。
- 静默吞 catch:`server.ts:271` `catch(err)`、`http/app.ts:161/241/308` `.catch(()=>({}))`。
- S4(PR #139)已临时加了几处 `[relay] console.error`(instance-gateway 超时/superseded、web-gateway broadcast、heartbeat terminate)——本部分**归并**进正式 logger。
- 部署:前台进程,pm2/systemd/Docker 托管;`pm2 logs xacpx-relay` 是运维读日志方式(`docs/relay-deployment.md:128-142`)。无 stop/status。

### 组件:`packages/relay/src/logging.ts`

- 自包含微型结构化 logger(不 import 核心)。
- 接口 `RelayLogger`:`debug/info/error(event: string, message: string, context?: Record<string, unknown>): void`,3 级(error/info/debug),同步 fire-and-forget(直接 `process.stdout/stderr.write`)。
- **路由**:`info/debug → stdout`,`error → stderr`。
- **格式**:镜像核心 `formatLogLine`——`${ISO} ${LEVEL} ${event} message=${json} ${k=json...}\n`(独立重实现约 15 行)。
- **级别**:`RELAY_LOG_LEVEL`(error/info/debug,默认 `info`)。不做 CLI flag。
- **测试缝**:构造可注入 `writeOut(line)` / `writeErr(line)`(默认真 stdout/stderr),便于单测断言。
- 工厂 `createRelayLogger(options?: { level?; writeOut?; writeErr?; now? }): RelayLogger`;noop 版 `createNoopRelayLogger()` 供不需日志的测试。

### 注入(正规参数 DI)

hub 有真正构造缝,走参数 DI:

- 在 `cli.ts`(`start` 分支)或 `startRelayServer` 建 `createRelayLogger({ level: RELAY_LOG_LEVEL })`。
- 传入 `createRelayRuntime`(`server.ts`)→ 下发 `InstanceGateway`、`WebGateway`、http app(`http/app.ts`)、`auth`。
- 各消费点通过构造/deps 接收 `RelayLogger`;把 S4 的 `[relay] console.error` 全部改成 `logger.error(...)`。

### 记什么(最小,不刷屏,绝不逐消息/逐 RPC)

- **启动**:`relay.start`(info)——httpPort、ws 模式/端口、dbPath、是否有 dashboard。保留现有 `io.print`(用户面),日志为结构化副本。
- **实例网关生命周期**(`gateway/instance-gateway.ts`):
  - `relay.instance.online`(info,instanceId+accountId)。
  - `relay.instance.offline`(info,instanceId+accountId)。
  - `relay.instance.superseded`(info,归并 S4 的 console.error)。
  - `relay.instance.handshake_failed`(info/error,带 reason,**不带 token**)。
- **心跳**:`relay.heartbeat.timeout` terminate(info,归并 S4)。
- **onEvent DB 写失败**(`server.ts` message 监听 try/catch,S4 加过):`relay.event.persist_failed`(error)。
- **登录**:被限流拒绝的登录(`auth`)`relay.login.rejected`(info/error,带 reason 但**不带 token/凭证**;若 auth 现成有客户端标识如 IP/hash 可带,否则不强求)。
- **静默 catch**:`server.ts:271`、`http/app.ts:161/241/308` → 相应 `logger.error/debug`,不再静默。
- **web socket** register/close:`relay.web.connected`/`disconnected`(debug,默认不显)。

---

## 测试策略

### Part A

- 新单测 `tests/unit/weixin/util/weixin-log.test.ts`:
  - 注入前调用为 noop(不抛、无副作用)。
  - `setWeixinLog(fakeAppLogger)` 后,`weixinLog.debug/info/error` 转发到对应 AppLogger 方法,event/message/context 透传。
- buildApp 接线:在 `tests/unit/main.test.ts`(或 build-app 相关)加断言——buildApp 后 `setWeixinLog` 生效(spy 注入的 AppLogger,触发一条 weixin 日志,断言经过它)。
- grep 断言(可作为一条测试或 CI 检查):无残留 `util/logger` import、`src/` 下无 `/tmp/openclaw` **日志目录**字面量(即 `path.join("/tmp", "openclaw")` 及 `openclaw-YYYY-MM-DD.log`)。**注意**:`openclaw-weixin`(状态目录子名 / provider 标识,遍布 `inbound.ts`/`accounts.ts` 等)是**完全无关的东西,必须原样保留**,断言不得误伤。
- 调用点重写机械改动,靠 `npx tsc --noEmit` + 既有 weixin 单测兜底(逐文件跑受影响的 `tests/unit/weixin/**`)。

### Part B

- 新单测 `tests/unit/packages/relay/logging.test.ts`:
  - 级别过滤(`RELAY_LOG_LEVEL=error` 时 info/debug 不输出)。
  - 路由:info/debug 走 `writeOut`,error 走 `writeErr`(注入缝断言)。
  - 格式:行含 ISO 时间、大写 LEVEL、event、`message=`、context 字段。
  - 默认级别 info。
- 网关集成:`InstanceGateway` online/offline 经注入的 fake `RelayLogger` spy 验证(扩现有 gateway 测试或新增)。
- 逐文件 `bun test`;relay 测试在 node 下也要过。

## 发布

纯代码合并,实机生效需另发 beta:core(带 weixin 改动)+ relay(带 hub 日志);protocol/channel-relay 不动。合并时不发,批次末尾再定。

## 文档

- `CLAUDE.md`:日志位置说明。
- `docs/relay-deployment.md`:补一句 `RELAY_LOG_LEVEL` 与 `pm2 logs`。

## 明确不做(YAGNI / 越界)

- 不给 AppLogger 加 `warn` 级或 child logger(只 2 处 withAccount,用 context 即可)。
- hub 不落文件、不自做轮转(交进程管理器)。
- 不做 CLI `--log-level` flag(env 足够)。
- 不碰其它子系统日志(feishu/yuanbao/perf-tracer 已各自妥当或另议)。
- 不引入结构化 JSON 输出模式 / 日志聚合 / 远程上报。
