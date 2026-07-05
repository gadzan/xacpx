# relay-web 刷新恢复(第 1+2 层)设计

> 状态:待实现。范围严格限定纯前端(仅 `packages/relay-web`),一个 hub beta 验收。

## 目标

浏览器刷新 / 崩溃重载(F5、页面重载)后,还原刷新前的**中置 tab 集**(文件 / diff / 终端)、**当前激活 tab**、以及**未保存的编辑草稿**,让用户回到刷新前的工作视图。

**明确不做(第 3 层,单独立项):** 终端输出内容 / scrollback 的补发与接回原 PTY。终端接不回是既有事实(后端 emit 即丢、无 ring buffer),本次只恢复"终端 tab 位置",不恢复其内容。

## 非目标 / 边界

- 不存文件内容:恢复 tab 后各自 `FileViewer` 走既有 `control.fs.read` 重新拉最新磁盘内容。存内容只会引入陈旧问题且无收益。
- 不改后端、不改协议、不动 `packages/relay` / `packages/channel-relay` / `src/control`。
- 不引入 pinia 持久化插件;沿用仓库既有"手写 sessionStorage/localStorage + try/catch 容错"模式。
- 寿命 = sessionStorage(只到关标签页),与既有输入框草稿(`lib/composer-drafts.ts`)语义一致。纯 F5/崩溃重载能恢复;关标签页/浏览器则清空。

## 架构总览

四个改动单元,互相解耦:

1. **center-tabs 持久化** — `stores/center-tabs.ts` 内加 hydrate(初始化读回)+ persist(deep watch 写回)。终端 tab 引入 `autostart` 语义,hydrate 回来的终端 tab 一律 `autostart=false`。
2. **终端懒启动** — `components/TerminalTab.vue` 按 `autostart` prop 决定挂载即 spawn 还是显示"启动新终端"占位。`DashboardView.vue` 传 `:autostart`。
3. **文件草稿库** — 新建 `lib/file-drafts.ts`,结构照抄 `lib/composer-drafts.ts`(flat `Record<string,string>` + sessionStorage + try/catch)。
4. **FileViewer 草稿接线** — `components/FileViewer.vue` 新增 `sessionKey` prop;`load()` 后若有草稿则灌入并进编辑态;编辑时写草稿、保存/取消时清草稿。`DashboardView.vue` 传 `:session-key="key"`。

数据流(恢复路径):
```
页面重载
  → center-tabs store 创建 → hydrate 从 sessionStorage 读回 bySession(终端 tab autostart=false)
  → DashboardView onMounted → reconcileCenterTabs 剪掉已不存在的 session(既有逻辑)
  → allOpenTabs() 重新渲染每个 tab 的 FileViewer / TerminalTab
      · FileViewer.load() 重拉磁盘内容;若 fileDrafts 有本 (sessionKey,path) 草稿 → 灌入 content + editing=true
      · TerminalTab autostart=false → 显示占位,不 spawn;用户点"启动"才 start()
```

## 现有事实(锚定实现)

- `stores/center-tabs.ts`:setup store `"center-tabs"`,`bySession = ref<Record<string, SessionTabs>>({})`。`CenterTab` 是 file/diff/terminal 判别联合;终端 tab 现为 `{ kind:"terminal"; id:"terminal" }`。`sessionKey(instanceId, alias)` 已导出。mutator:`openFile/openDiff/openTerminal/setActive/closeTab/reorder/clearSession/setDirty/closeTabGuarded`。
- `lib/composer-drafts.ts`:`loadDraft(draftKey): string` / `saveDraft(draftKey, text)`;KEY=`"xacpx.composer-drafts.v1"`;flat `Record<string,string>`;空文本删键;read/write 均 try/catch 吞异常。
- `FileViewer.vue`:props `{ instanceId, workspace, path?, diffPath?, line?, lineRev? }`;`load()`(FileViewer.vue:39)读文件后设 `content.value = result.content; editing.value=false`;`watch([instanceId,workspace,path,diffPath], load, {immediate:true})`;`editDirty = editing && content !== file.content`(FileViewer.vue:92)并 `watch(editDirty, v => emit("dirty-change", v))`。已有 `startEdit()/save()/cancelEdit()` 写路径 + `baseRev` mtime 陈旧写保护。
- `DashboardView.vue`:`allOpenTabs()` v-for 里 `key` 即 sessionKey;已有 `keyInstance/keyAlias/keyWorkspace(key)` 派生器;FileViewer 传 `:instance-id="keyInstance(key)" :workspace="keyWorkspace(key)"`,TerminalTab 传 `:session-alias="keyAlias(key)"`。`reconcileCenterTabs`(onMounted)剪掉不存在 session 的 tab 集。
- `TerminalTab.vue`:`onMounted(() => void start())` 无条件 spawn;`watch([instanceId,sessionAlias], () => void start())`;`start()` 调 `terminals.create(...)` 新开 PTY;props 现为 `{ instanceId, sessionAlias }`。

## 单元设计

### 单元 1 — center-tabs 持久化(`stores/center-tabs.ts`)

**类型变更:** 终端 tab 变体加可选 `autostart`:
```ts
| { kind: "terminal"; id: string; autostart?: boolean };
```

**mutator 变更:** `openTerminal` 建终端 tab 时置 `autostart: true`(用户主动开 → 挂载即 spawn,维持现状 UX):
```ts
function openTerminal(key: string): void {
  upsertAndActivate(key, { kind: "terminal", id: "terminal", autostart: true });
}
```

**持久化(store 内新增,不引插件):**
- 常量 `const STORAGE_KEY = "xacpx.center-tabs.v1";`
- `hydrate()`:`sessionStorage.getItem(STORAGE_KEY)` → `JSON.parse`,结构为 `Record<string, SessionTabs>`。try/catch 失败或非对象 → 返回 `{}`。**读回后把每个终端 tab 的 `autostart` 强制改成 `false`**(刷新后接不回,一律懒启动)。在 store 工厂里 `bySession.value = hydrate();`(初值)。
- persist:`watch(bySession, (v) => persist(v), { deep: true })`;`persist(v)` = try/catch 包 `sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v))`,失败静默(存储满/禁用)。
- hydrate 的健壮性:只接受 `tabs` 为数组、`activeId` 为字符串的 session 条目;不符则丢弃该条目(不是整个丢)。防止损坏数据让 store 崩。

**Interfaces**
- Produces:`CenterTab` 终端变体新增 `autostart?: boolean`;store 行为不变(现有 mutator 签名不动)。
- Consumes:浏览器 `sessionStorage`、`vue` 的 `watch`。

### 单元 2 — 终端懒启动(`components/TerminalTab.vue` + `DashboardView.vue`)

**TerminalTab.vue:**
- props 新增 `autostart: boolean`(必填,DashboardView 显式传)。
- 新增本地 `const started = ref(false);`。
- `onMounted`:`if (props.autostart) void start();`——否则不 spawn。
- `start()` 内部成功进入后置 `started.value = true`(已 spawn 过就不再回占位)。
- prop-watch `watch([instanceId, sessionAlias], ...)`:改为仅当 `started.value`(已经在跑)时才 `void start()` 重启,避免懒态下因 prop 变化误 spawn。
- 模板:当 `!started` 时渲染占位层(替代终端 canvas),内容 = 一句说明(i18n `terminal.restoredHint`,如"终端会话已随刷新断开")+ 一个按钮(i18n `terminal.startNew`,如"启动新终端"),按钮 `@click="void start()"`。header(标题 / 关闭)照常显示。`started` 后渲染既有终端视图。

**DashboardView.vue:** TerminalTab 传 `:autostart="tab.autostart ?? false"`(v-for 内 `tab` 在该分支已是终端变体)。

**Interfaces**
- Consumes:`autostart` prop、`terminals.create`(既有)。
- 行为契约:`autostart=true` 挂载 = 现状(立即 spawn);`autostart=false` 挂载 = 不 spawn、显占位、点按钮才 spawn。

### 单元 3 — 文件草稿库(`lib/file-drafts.ts`,新建)

照抄 `composer-drafts.ts` 结构,独立 KEY:
```ts
const KEY = "xacpx.file-drafts.v1";
type Drafts = Record<string, string>;
// read()/write() 同 composer-drafts:try/catch 吞异常,write 失败静默(配额兜底)

export function draftKey(sessionKey: string, path: string): string {
  return `${sessionKey}::${path}`;
}
export function loadFileDraft(key: string): string | null {
  if (!key) return null;
  const v = read()[key];
  return v ?? null;   // 用 null 区分"无草稿",空串是合法草稿(全删空的编辑)
}
export function saveFileDraft(key: string, text: string): void { /* 有 text 写、无则删键;write try/catch */ }
export function clearFileDraft(key: string): void { /* 删键 */ }
```
说明:草稿键 = `${sessionKey}::${path}`,与 center-tabs 的 per-session 身份对齐(两个 session 编辑同一文件 = 两份独立草稿,匹配两个独立 tab / dirty)。write 的 try/catch 即配额兜底:`QuotaExceeded`(大文件草稿撑爆 ~5MB)时静默跳过,tab 仍会恢复(重拉磁盘),只是那份草稿不保。

**Interfaces**
- Produces:`draftKey / loadFileDraft / saveFileDraft / clearFileDraft`。
- Consumes:`sessionStorage`。

### 单元 4 — FileViewer 草稿接线(`components/FileViewer.vue` + `DashboardView.vue`)

**FileViewer.vue:**
- props 新增 `sessionKey: string`(DashboardView 传 v-for 的 `key`)。
- `load()` 成功读到文件后(FileViewer.vue:50 一带),在 `content.value = result.binary ? "" : result.content; editing.value = false;` 之后:
  ```ts
  if (path && !result.binary) {
    const dk = draftKey(props.sessionKey, path);
    const draft = loadFileDraft(dk);
    if (draft !== null && draft !== result.content) {
      content.value = draft;
      editing.value = true;
      baseRev.value = typeof result.mtimeMs === "number" ? { mtimeMs: result.mtimeMs, size: result.size } : null;
    }
  }
  ```
  说明:`draft !== result.content` 时才进编辑态(草稿与磁盘已一致就不当 dirty,顺带覆盖"别处存了相同改动"边界)。恢复不比对 mtime——真去保存时既有 `baseRev` 陈旧写保护兜底。`baseRev` 需设成本次读回的 mtime/size(等价于 `startEdit()` 里的快照),让保存路径有陈旧令牌。
- 编辑时持久化:新增 `watch(content, ...)`——`editing.value` 为真时,`editDirty` 为真则 `saveFileDraft(draftKey(sessionKey, path), content.value)`,否则(改回原样)`clearFileDraft(...)`。仅在 `editing` 且有 `path` 时写,避免只读态误写。
- 清理:`save()` 成功后、`cancelEdit()` 里各 `clearFileDraft(draftKey(sessionKey, props.path))`。
- 注意 `editDirty`(FileViewer.vue:92)已存在并驱动 `dirty-change` emit → `setDirty`;恢复进编辑态后它自然为真 → tab dirty 点亮,无需额外接线。

**DashboardView.vue:** FileViewer 传 `:session-key="key"`。

**Interfaces**
- Consumes:`sessionKey` prop、`lib/file-drafts` 的四个函数。
- 行为契约:有草稿 → 恢复进编辑态 + dirty;无草稿 → 现状(只读);save/cancel 后草稿清除。

## 错误处理

- sessionStorage 读:任何解析异常 → 视作空(回到"无恢复"),绝不抛。
- sessionStorage 写:任何异常(配额满 / 隐私模式禁用)→ 静默跳过,功能降级为"不持久化",不阻塞交互、不报错。
- hydrate 结构校验:逐 session 条目校验,坏条目丢弃,不因单条坏数据丢掉整份或崩溃。
- 终端懒态:占位只在"从未 start 过"显示;一旦 start 过就不回退(PTY 之后断开是既有行为,不在本范围)。

## 测试策略

跑法:`cd packages/relay-web && npx vitest run`(jsdom,**绝不用 bun test**);类型 `npx vue-tsc --noEmit`。新增/删除 i18n 键必须过 `i18n-parity.test.ts`(en.ts / zh-CN.ts 同步)。CodeMirror 在 jsdom 报 `getClientRects is not a function`,已在 `src/__tests__/setup.ts` stub;终端测试复用既有 `ghostty-web` 动态 import 的 mock 先例。

**单元测试(纯函数,最扎实):**
- `lib/file-drafts.test.ts`:
  - `draftKey` 组合正确。
  - save→load round-trip 返回原文;空串合法(load 返 `""` 而非 `null`)。
  - 无草稿 `loadFileDraft` 返 `null`。
  - `saveFileDraft(key, "")` 删键;`clearFileDraft` 删键。
  - 损坏 JSON(`sessionStorage` 塞非法值)→ load 返 `null`、不抛。
  - `setItem` 抛(mock 抛 QuotaExceeded)→ `saveFileDraft` 吞掉不抛。
- center-tabs 持久化(扩充 `stores/center-tabs.test.ts` 或新增):
  - mutator(openFile / openTerminal / setActive / closeTab)后 sessionStorage `xacpx.center-tabs.v1` 被写、内容含该 tab。
  - hydrate:预置 sessionStorage → 新建 store → `tabsFor/activeFor` 还原。
  - hydrate 把终端 tab 的 `autostart` 强制为 `false`(预置 `autostart:true` 也读成 false)。
  - `openTerminal()` 新建的终端 tab `autostart === true`。
  - 损坏值(非 JSON / 非对象 / 坏 session 条目)→ 不崩,坏条目丢弃、好条目保留。

**组件测试(jsdom mount):**
- FileViewer:
  - `load()` 时存在草稿(mock `files.readFile` 返回内容 + 预置草稿)→ `content` = 草稿、进编辑态、`dirty-change` emit true。
  - 草稿 == 磁盘内容 → 不进编辑态(只读)。
  - 无草稿 → 只读态、`content` = 磁盘内容。
  - 编辑改动 → sessionStorage 写入草稿;`cancelEdit()` / `save()` 成功 → 草稿清除。
- TerminalTab:
  - `autostart=false` 挂载 → 不调 `terminals.create`、渲染占位(按 data-test 断言)。
  - 点占位"启动"按钮 → 调一次 `terminals.create`、占位消失。
  - `autostart=true` 挂载 → 直接调 `terminals.create`(维持现状,回归)。

## i18n

新增两个终端占位文案键(en.ts + zh-CN.ts 同步,过 parity 测试):
- `terminal.restoredHint` — en: "This terminal disconnected on reload." / zh: "终端会话已随刷新断开。"
- `terminal.startNew` — en: "Start new terminal" / zh: "启动新终端"。

## 交付与验收

- 纯前端,只动 `packages/relay-web`;UI-only → 只 bump hub(`@ganglion/xacpx-relay`)一个 beta。
- 验收(实机):打开若干文件 tab + 一个 diff + 一个终端,编辑某文件不保存 → 硬刷新 → tab 集/激活 tab 还原、草稿仍在且处编辑态、终端 tab 在但显"启动新终端"占位;点占位启动 → 正常新 shell;关标签页重开 → 不恢复(sessionStorage 语义)。
