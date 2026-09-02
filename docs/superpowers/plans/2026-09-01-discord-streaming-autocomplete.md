# Discord Streaming & Autocomplete Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Discord `/ss` startup to show immediate streaming progress like Feishu, stop dropping intermediate updates, and provide slash-command autocomplete via Discord Application Commands.

**Architecture:** Keep existing `DiscordChannel` text-command pipeline. Shorten preview gate so session-create progress is visible in <300ms, concatenate streamed progress with final router text, forward tool/thought events into preview, and add optional Application Commands registration that maps `xacpx` parsed commands to Discord native slash commands when `applicationId` is configured.

**Tech Stack:** TypeScript (ESM, Bun), `discord.js` `REST` v10, `bun:test`, `npx tsc --noEmit`

## Global Constraints

- Runtime import via `xacpx/plugin-api` only; `bunx publint` must pass before publish.
- `start()` first line `setChannelLocale(input.locale ?? "en")`; log codes `discord.<area>.<verb>`.
- `allowed_mentions: { parse: [] }` on every outbound.
- `chatKey` format `discord:<accountId>:<kind>:<channelId>` with `accountId` must not contain `:` [config.ts:assertValidAccountId].
- Outbound media must pass `resolveSafeOutboundMediaPath`.
- Do not add voice/presence/exec-approval features.
- Preview semantics F2: preview is process viewer, final answer always new MESSAGE_CREATE even for short answers.
- Consumer lock per-token composite remains unchanged.

---

### Task 1: Make session-create progress visible immediately (preview-stream + progress timing)

**Files:**
- Modify: `packages/channel-discord/src/preview-stream.ts:19-136`
- Modify: `packages/channel-discord/src/channel.ts:956-984` (preview creation options)
- Test: `tests/unit/packages/channel-discord/discord-preview-stream.test.ts`

**Interfaces:**
- Consumes: `DiscordClientLike`, `DeliveryTarget`
- Produces: `createDiscordPreviewStream(options)` with corrected `minInitialChars` handling; `DiscordChannel.runTurn` passes `previewThrottleMs`/`minInitialChars` correctly

**Context:** Today `minInitialChars=200` + `update()` early-return swallows `🚀 Starting omp…` (≈20 chars) and the later `ℹ️ [acpx] …` (≈60 chars) until both together still <200, so no `MESSAGE_CREATE` is ever sent; the 4s gap is `DEBOUNCE_MS=3000` in `src/commands/transport-invoker.ts:99-144`. Feishu seeds a `StreamingCardController` immediately before `agent.chat`, so user sees progress at t≈0.

**Decision:** Keep `DEFAULT_DISCORD_TUNING.minInitialChars=200` for long agent turns (avoids noisy empty preview), but session-create progress must bypass it. Two cooperating changes:
1. `preview-stream.ts` — allow progress pings to create immediately even if <200 (or lower the preview default for Discord to 1 when `replyMode=streaming` and text is a transport progress note). Simplest: change `update()` so the *first* `update` with any non-empty text creates immediately when `throttleMs` elapsed, and keep `minInitialChars` only for the *first accumulation* async — measure by elapsed time, not char count, for progress.
2. `channel.ts` — ensure `accumulated` that holds progress is also delivered via preview instantly, not held until 200.

Alternative chosen: reduce `minInitialChars` default for Discord preview from 200 to 20 and ensure `runTurn` creates preview with `minInitialChars: 1` for the session-create path, or simply change `DEFAULT_DISCORD_TUNING.minInitialChars` to `20` and adjust `update()` to schedule even when < threshold after a short grace (200ms). Any solution where `🚀 Starting` appears within 300ms on fake timers is acceptable, but must not break existing test `"preview defers creation until minInitialChars"`.

- [ ] **Step 1: Write failing test — short progress visibly creates preview**

```ts
// tests/unit/packages/channel-discord/discord-preview-stream.test.ts
test("short progress like '🚀 Starting omp…' creates preview promptly", async () => {
  vi.useFakeTimers();
  const { client, sent } = createFakeClient();
  // use defaults that previously hid short text
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 200 });
  preview.update("🚀 Starting omp…");
  vi.advanceTimersByTime(400);
  await Promise.resolve(); await Promise.resolve();
  // BEFORE fix: sent.length === 0 (bug); AFTER fix: expect 1
  expect(sent.length).toBe(1);
  expect(sent[0]!.content).toBe("🚀 Starting omp…");
  vi.useRealTimers();
});
```

Run: `bun test tests/unit/packages/channel-discord/discord-preview-stream.test.ts -t "short progress" -v`
Expected: FAIL (sent.length 0)

- [ ] **Step 2: Fix `preview-stream.ts` gating**

Replace the `messageId===null && text.length < minInitialChars` early-return with a time-gated variant. Minimal patch that satisfies both old and new tests:

```ts
// packages/channel-discord/src/preview-stream.ts ~19
const minInitialChars = options.minInitialChars ?? 20; // lower from 200
// in update():
if (messageId === null && text.length < minInitialChars) {
  // keep debouncing but ensure a short progress is not starved:
  // schedule a flush after throttleMs even when below threshold, so
  // "🚀 Starting" appears within one throttle window.
  if (!timer && !creating && !editing && !closed && !overflow) schedule();
  return;
}
```

Alternatively set default `minInitialChars` to `20` via `tuning.ts:DEFAULT_DISCORD_TUNING` and keep logic. Either is acceptable if tests above pass.

Also ensure `previewStream.update` is called on every `safeReply` delta, and that throttle still coalesces rapid deltas.

- [ ] **Step 3: Verify new behavior**

Run same test: expect PASS.

Run existing: `bun test tests/unit/packages/channel-discord/discord-preview-stream.test.ts -v`  — the original `"defers creation until minInitialChars"` test must be updated to expect `minInitialChars:5` still defers `hi` (2 chars) but allows `hello world` (11 chars). If default lowered to 20, that test still passes because `minInitialChars:5` explicit. No other change.

- [ ] **Step 4: Wire `channel.ts` to use tighter preview for session-create**

In `channel.ts:958-967` ensure `createDiscordPreviewStream` receives `minInitialChars: 1` when the turn is a session command (`requestText.trim().startsWith("/")`) or simply pass `1` always for streaming mode. E.g.:

```ts
active.previewStream = createDiscordPreviewStream({
  client: runtime.client,
  target,
  maxChars: 2000,
  throttleMs: runtime.account.previewThrottleMs,
  minInitialChars: 1, // was runtime.account.minInitialChars (200)
  onWarn: (msg) => { void this.logger?.warn("discord.preview.warn", msg, { accountId, channelId }); },
});
```

If keeping configurable, change `config.ts` default `DEFAULT_MIN_INITIAL_CHARS = 20` (from 200) so new accounts get prompt feedback.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-discord/src/preview-stream.ts packages/channel-discord/src/tuning.ts packages/channel-discord/src/channel.ts tests/unit/packages/channel-discord/discord-preview-stream.test.ts
git commit -m "fix(channel-discord): show session-create progress immediately (preview no longer starved by 200-char gate)"
```

---

### Task 2: Deliver complete answer and forward agent stream events (finalText + tool/thought)

**Files:**
- Modify: `packages/channel-discord/src/channel.ts:979-1030` (`runTurn` safeReply accumulation, agent.chat call, deliverFinalResponse)
- Test: `tests/unit/packages/channel-discord/discord-channel.test.ts` (new cases) or extend existing stub

**Interfaces:**
- Consumes: `TransportInvoker.promptTransportSession`, `StreamingPromptState` callbacks
- Produces: `DiscordChannel.runTurn` correctly forwards `onToolEvent/onThought/onPlan/onUsage/onCommands` and merges `accumulated + response.text`

**Context:** `finalText = accumulated || response.text` drops `sessionCreated` when progress exists. Also `agent.chat` call only passes `reply` [channel.ts:987-1001], so ACP `tool_call`/`agent_thought_chunk`/`plan` never reach Discord preview. Feishu passes all four when `cardController` exists [channel.ts:749-764].

- [ ] **Step 1: Write failing test — final text concatenates progress + router result**

Add to a new or existing channel test that injects a fake agent:

```ts
// tests/unit/packages/channel-discord/discord-channel.test.ts
test("runTurn finalText merges streamed progress and router response", async () => {
  const { channel, fakeAgent, fakeClient, sent } = setupDiscordChannel({
    replyMode: "streaming",
    agentReply: async (opts) => {
      await opts.reply?.("🚀 Starting omp…");
      await opts.reply?.("ℹ️ note");
      return { text: "Session xacpx:omp created" };
    },
  });
  await channel["handleMessageEvent"]("default", fakeDiscordMessage("/ss omp -ws xacpx"));
  // wait executor
  await vi.waitFor(() => expect(sent.some(s => s.content.includes("Session xacpx:omp created"))).toBe(true));
  // must contain both progress and final
  const combined = sent.map(s=>s.content).join("\n");
  expect(combined).toContain("🚀");
  expect(combined).toContain("Session xacpx:omp created");
});
```

Run: `bun test tests/unit/packages/channel-discord/discord-channel.test.ts -t "merges streamed" -v` Expect FAIL (final only contains progress).

- [ ] **Step 2: Fix `channel.ts:979-1030` — merge and forward events**

Change accumulation + final:

```ts
let accumulated = "";
const safeReply = async (delta: string): Promise<void> => {
  if (active.suppressed) return;
  accumulated += delta;
  // also keep plain text preview in sync; tool events will append separately
  active.previewStream?.update(accumulated);
};

const buildPreviewToolLine = (e: ToolUseEvent): string => {
  // lightweight: mirror feishu format without card — e.g. `🔧 tool · ${e.title}`
  const emoji = TOOL_EMOJI[e.kind] ?? "🔧";
  return `${emoji} ${e.title ?? e.kind}`;
};

// in runTurn before agent.chat:
const onToolEvent = async (e: ToolUseEvent) => {
  if (active.suppressed) return;
  const line = buildPreviewToolLine(e);
  accumulated += (accumulated ? "\n" : "") + line;
  active.previewStream?.update(accumulated);
};
// similarly onThought appends line, onPlan renders plan bullets, onUsage ignored for text

try {
  const response = await this.agent.chat({
    accountId,
    conversationId: chatKey,
    text: requestText,
    ...(media.length>0?{media}:{}),
    replyContextToken: messageId,
    metadata: { channel:"discord", chatType: route.kind==="dm"?"direct":"group", senderId: active.senderId, groupId: guildId, ...(boundAlias?{boundSessionAlias:boundAlias}:{})},
    reply: safeReply,
    onToolEvent, onThought: async (c)=>{ accumulated += c; active.previewStream?.update(accumulated); },
    abortSignal: abortController.signal,
  });
  // ...
  const finalText = [accumulated, response.text].filter(s=> s && s.trim().length>0).join("\n\n");
  await this.deliverFinalResponse({ runtime, target, finalText, ... });
}
```

If forwarding all callbacks is too heavy, at minimum fix `finalText` merging:

```ts
const finalText = [accumulated.trim(), (response.text??"").trim()].filter(Boolean).join("\n\n") || response.text || accumulated;
```

Also ensure preview cleanup deletes preview before final send (existing) so final is always new `MESSAGE_CREATE`.

- [ ] **Step 3: Run tests — must pass new and existing**

`bun test tests/unit/packages/channel-discord/discord-channel.test.ts -v`
`npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add packages/channel-discord/src/channel.ts tests/unit/packages/channel-discord/discord-channel.test.ts
git commit -m "fix(channel-discord): merge streamed progress with final text and stream tool/thought into preview"
```

---

### Task 3: Discord Application Commands for autocomplete

**Files:**
- Create: `packages/channel-discord/src/discord-commands.ts`
- Modify: `packages/channel-discord/src/discord-client.ts` (add `registerCommands`, `onInteraction` hook, expose `applicationId`)
- Modify: `packages/channel-discord/src/channel.ts` (register on start, handle interactionCreate)
- Modify: `packages/channel-discord/src/config.ts` (require `applicationId` when `registerCommands` enabled; add `enableAutocomplete` bool)
- Test: `tests/unit/packages/channel-discord/discord-commands.test.ts` + `discord-provider.test.ts` update

**Interfaces:**
- Consumes: `discord.js` `REST` v10, `Routes.applicationCommands`, `Routes.applicationGuildCommands`
- Produces: `registerDiscordCommands({token, applicationId, guildId?, commands})`, `buildXacpxSlashCommands(): Array<{name, description, options}>`

**Context:** Text commands require users to know `/ss`, `/use`, etc. Discord native autocomplete comes from registered Application Commands. Design doc v1 deliberately left them out, but user feedback demands them. Scope here is global commands for the core xacpx surface: `help`, `ss`, `use`, `cancel`, `status`, `sessions` etc mapped from `src/commands/parse-command.ts:77-400`.

- [ ] **Step 1: Write failing test — command builder emits expected names**

```ts
// tests/unit/packages/channel-discord/discord-commands.test.ts
import { buildXacpxSlashCommands } from "../../packages/channel-discord/src/discord-commands";
import { expect, test } from "bun:test";
test("builds xacpx slash commands matching core aliases", () => {
  const cmds = buildXacpxSlashCommands();
  const names = cmds.map(c=>c.name);
  expect(names).toContain("help");
  expect(names).toContain("ss");
  expect(names).toContain("use");
  expect(names).toContain("cancel");
  expect(names).toContain("status");
  expect(cmds.find(c=>c.name==="ss")!.description).toMatch(/session/i);
});
```

Run: `bun test tests/unit/packages/channel-discord/discord-commands.test.ts -v` Expect FAIL (module missing)

- [ ] **Step 2: Implement `discord-commands.ts`**

```ts
// packages/channel-discord/src/discord-commands.ts
export interface DiscordSlashCommand { name: string; description: string; options?: unknown[]; }
export function buildXacpxSlashCommands(): DiscordSlashCommand[] {
  return [
    { name: "help", description: "Show xacpx help" },
    { name: "ss", description: "Session shortcut: /ss <agent> -d <path> (creates or reuses session)", options: [
      { name:"agent", type:3, description:"agent id", required:true },
      { name:"workspace", type:3, description:"workspace path or name" },
      { name:"new", type:5, description:"force new session" },
    ]},
    { name:"use", description:"Switch to session" },
    { name:"cancel", description:"Cancel current or named session" },
    { name:"status", description:"Show current session status" },
    { name:"sessions", description:"List sessions" },
  ];
}
export async function registerDiscordCommands(opts:{token:string; applicationId:string; guildId?:string; commands:DiscordSlashCommand[]}): Promise<void> {
  const { REST } = await import("discord.js");
  const rest = new REST({version:"10"}).setToken(opts.token);
  const { Routes } = await import("discord.js");
  const route = opts.guildId ? Routes.applicationGuildCommands(opts.applicationId, opts.guildId) : Routes.applicationCommands(opts.applicationId);
  await rest.put(route, { body: opts.commands });
}
```

Keep import lazy to avoid hard dep in tests; mock `REST` via `deps` injection for tests.

- [ ] **Step 3: Integrate registration in `channel.ts:startAccount`**

After `identity` is validated, if `account.applicationId` and `runtime.account.enableAutocomplete !== false`, call `registerDiscordCommands` (best-effort, log `discord.commands.register_failed` on error but do not fail account start). Add `enableAutocomplete` boolean to `DiscordResolvedAccountConfig` with default `true` when `applicationId` present.

Also add `client.on("interactionCreate", ...)` mapping: if interaction is chat-input command, build `requestText` like `/<name> <args>` and feed through `handleMessageEvent` path or directly into `executor.run` with a synthetic `DiscordInboundMessage` that carries `isInteraction=true`. Simplest: in `DiscordJsClient.start` add:

```ts
client.on("interactionCreate", async (interaction: any) => {
  if (!interaction.isChatInputCommand?.()) return;
  const text = `/${interaction.commandName} ${interaction.options?.data?.map((o:any)=> o.value).join(" ") ?? ""}`.trim();
  const inbound = mapInteractionToInbound(interaction, accountId); // reuse inbound.ts helpers
  input.handlers.onMessage(inbound);
  // acknowledge quickly to avoid 3s timeout
  try { await interaction.deferReply(); } catch {}
});
```

For test seam, expose `createDiscordCommandsRegistrar` via `deps`.

- [ ] **Step 4: Config & provider updates**

`config.ts`: add `enableAutocomplete?: boolean` to `DiscordAccountConfig`/`Resolved`, parse via `booleanOptional`, default `true` when `applicationId` provided else `false`. `parseDiscordChannelConfig` should not throw if `applicationId` missing — autocomplete simply disabled. Add `autocompleteTuning` if needed.

`discord-provider.ts:parseAddArgs`: add `--application-id` already exists, add `--autocomplete` boolean flag.

- [ ] **Step 5: Tests pass**

`bun test tests/unit/packages/channel-discord/discord-commands.test.ts tests/unit/packages/channel-discord/discord-provider.test.ts tests/unit/packages/channel-discord/discord-inbound.test.ts -v`
`npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add packages/channel-discord/src/discord-commands.ts packages/channel-discord/src/discord-client.ts packages/channel-discord/src/channel.ts packages/channel-discord/src/config.ts tests/unit/packages/channel-discord/discord-commands.test.ts
git commit -m "feat(channel-discord): register Discord Application Commands for autocomplete"
```

---

### Task 4: Docs, i18n and config polish

**Files:**
- Modify: `packages/channel-discord/README.md` (add autocomplete section)
- Modify: `packages/channel-discord/src/i18n/*.ts` (add `autocomplete*` keys)
- Modify: `docs/superpowers/specs/2026-08-28-discord-channel-plugin-design-from-hy4.md` (add F9)
- Test: `tests/unit/packages/channel-discord/no-hardcoded-cjk.test.ts` must still pass

**Interfaces:**
- Consumes: tasks 1-3
- Produces: user-visible docs matching runtime behavior

- [ ] **Step 1: Update README — explain text vs native slash**

Add subsection `### Slash command autocomplete` after `### Reply modes`:

```
Discord v1 uses text commands via `@bot /ss …` (like Feishu). When `options.applicationId` is set, the plugin also registers native Application Commands (`/help`, `/ss`, `/use`, `/cancel`, `/status`, `/sessions`) so typing `/` shows autocomplete. Registration is best-effort at Gateway start; failures log `discord.commands.register_failed` and do not prevent message delivery. Without `applicationId`, only text commands work.
```

Update `Commands` CLI example to include `--autocomplete true|false`.

- [ ] **Step 2: i18n — add `providerAutocompleteDisabled` etc.** Mirror `feishu` style, keep `setChannelLocale` contract.

- [ ] **Step 3: Run `bun test tests/unit/packages/channel-discord/no-hardcoded-cjk.test.ts -v` and `npx tsc --noEmit`**

- [ ] **Step 4: Commit**

```bash
git add packages/channel-discord/README.md packages/channel-discord/src/i18n/* docs/superpowers/specs/*
git commit -m "docs(channel-discord): document streaming preview and application-commands autocomplete"
```

---

## Verification Gates (run by coordinator, not dispatch)

- `npx tsc --noEmit` clean
- `bun test tests/unit/packages/channel-discord -v` all green (9 suites)
- `bunx publint --pack packages/channel-discord` (from skill lane)
- Manual dry-run: `bun run dry-run --chat-key discord:default:g:chan1 -- "/ss omp -ws xacpx" "hi"` shows `🚀 Starting` within one throttle tick and final merged text
```

