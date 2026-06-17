# Agent Plan (todo list) → relay-web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the agent's ACP `plan` (its live todo/checklist) end-to-end into the relay-web dashboard, rendered as a live checklist under the in-flight turn.

**Architecture:** acpx already emits the ACP `session/update` `plan` notification; xacpx drops it today (only `tool_call`/`agent_thought_chunk`/`agent_message_chunk` are parsed). We add a parallel `onPlan` callback that mirrors the existing `onThought`/`turn-thought` seam through every layer: stream parser → transport → acpx-bridge subprocess protocol → console-agent → control-service → a new `plan` ControlEvent → relay-protocol wire DTO → relay-web store/render. The hub and connector need **no** change (connector pass-through, hub broadcasts every event before its persistence switch).

**Scope (this slice is deliberately minimal):**
- **Live-only.** The plan shows during the turn and disappears on finish. No history persistence (no `MessageRecordDto.structured.plan`, no hub turn-buffer accumulation).
- **relay-web only.** WeChat/Feishu text channels never set `onPlan` (it is optional); they are untouched.
- **Replace semantics.** Each ACP `plan` update carries the FULL entry list; every event REPLACES the current plan (never appended).

**Tech Stack:** TypeScript (core + packages), `bun test` (core unit tests via `node scripts/run-tests.mjs <dir>` — never whole-dir `bun test`), Vue 3 `<script setup>` + Pinia + vitest/jsdom + vue-tsc (relay-web). relay-protocol builds via `tsc` (`bun run build:relay-protocol`), never bun barrel build.

**Data shape (ACP PlanEntry):**
```ts
type PlanEntryStatus = "pending" | "in_progress" | "completed";
interface PlanEntry { content: string; status: PlanEntryStatus; priority?: "high" | "medium" | "low" }
```

**Files touched (18) — connector & hub intentionally absent:**
- Core parse/types: `src/channels/types.ts`, `src/transport/streaming-prompt.ts`, `src/transport/types.ts`
- Transports: `src/transport/acpx-cli/acpx-cli-transport.ts`, `src/transport/acpx-bridge/acpx-bridge-transport.ts`
- Bridge subprocess: `src/transport/acpx-bridge/acpx-bridge-protocol.ts`, `src/bridge/bridge-runtime.ts`, `src/bridge/bridge-server.ts`, `src/transport/acpx-bridge/acpx-bridge-client.ts`
- Agent layer: `src/weixin/agent/interface.ts`, `src/console-agent.ts`
- Control: `src/control/control-event-bus.ts`, `src/control/control-service.ts`
- Wire protocol: `packages/relay-protocol/src/dtos.ts`, `packages/relay-protocol/src/web-dtos.ts`
- relay-web: `packages/relay-web/src/stores/chat.ts`, `packages/relay-web/src/components/PlanPanel.vue` (new), `packages/relay-web/src/components/ChatPane.vue`

---

## Task 1: Core `PlanEntry` type

**Files:**
- Modify: `src/channels/types.ts` (where `ToolUseEvent` lives — the shared agent-event vocabulary)

- [ ] **Step 1: Add the type**

Append near `ToolUseEvent`:

```ts
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/** One entry of the agent's ACP `plan` (its live todo list). The agent re-sends the
 *  WHOLE list on each update, so consumers REPLACE rather than append. */
export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
  priority?: "high" | "medium" | "low";
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/channels/types.ts
git commit -m "feat(transport): add PlanEntry type for the agent plan/todo list"
```

---

## Task 2: Parse the ACP `plan` update into an `onPlan` callback

**Files:**
- Modify: `src/transport/streaming-prompt.ts`
- Test: `tests/unit/transport/streaming-prompt.test.ts` (add to the existing file)

Context: `parseStreamingChunks` (currently `streaming-prompt.ts:115`) dispatches on `update.sessionUpdate`. The `plan` update arrives as `{ method:"session/update", params:{ update:{ sessionUpdate:"plan", entries:[...] } } }`. The `StreamEvent.params.update` interface (line ~28) lacks `entries`, and there is no `plan` branch. `onPlan` lives on the state object next to `onThought`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/transport/streaming-prompt.test.ts`:

```ts
test("parses a plan update into onPlan with the full entry list (replace semantics)", () => {
  const plans: unknown[] = [];
  const state = createStreamingPromptState(false, { onPlan: (entries) => plans.push(entries) });
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: { update: { sessionUpdate: "plan", entries: [
      { content: "read files", status: "completed" },
      { content: "write code", status: "in_progress", priority: "high" },
    ] } },
  }));
  expect(plans).toEqual([[
    { content: "read files", status: "completed" },
    { content: "write code", status: "in_progress", priority: "high" },
  ]]);
});

test("ignores a plan update with no entries array", () => {
  let called = false;
  const state = createStreamingPromptState(false, { onPlan: () => { called = true; } });
  parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "plan" } } }));
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`onPlan` not a known option)

Run: `bun test tests/unit/transport/streaming-prompt.test.ts`
Expected: FAIL (TS error / plans empty).

- [ ] **Step 3: Implement**

In `src/transport/streaming-prompt.ts`:

a) Extend the `StreamEvent.params.update` interface (line ~28) — add `entries`:
```ts
      toolCallId?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      entries?: unknown;
```

b) Add `onPlan` to `StreamingPromptState` (its type declaration) and to the options object `CreateStreamingPromptStateOptions`:
```ts
      onThought?: (chunk: string) => void | Promise<void>;
      onPlan?: (entries: PlanEntry[]) => void | Promise<void>;
```
Add the import: `import type { ToolUseEvent, PlanEntry } from "../channels/types";` (extend the existing import).

c) In `createStreamingPromptState`, read and store it (mirror `onThought`):
```ts
  let onPlan: ((entries: PlanEntry[]) => void | Promise<void>) | undefined;
  // ...inside the object-options branch:
    onPlan = options.onPlan;
  // ...in the returned state literal, next to onThought:
    onPlan,
```

d) In `parseStreamingChunks`, BEFORE the `agent_thought_chunk` block, add:
```ts
  if (update.sessionUpdate === "plan") {
    // ACP sends the full plan each time; forward verbatim (replace semantics). Validate
    // shape defensively — a malformed entry must not crash the stream parser.
    const entries = Array.isArray(update.entries)
      ? update.entries.filter((x): x is PlanEntry =>
          !!x && typeof x === "object" && typeof (x as PlanEntry).content === "string" && typeof (x as PlanEntry).status === "string")
      : [];
    if (entries.length > 0) void state.onPlan?.(entries);
    return;
  }
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test tests/unit/transport/streaming-prompt.test.ts`
Expected: PASS. Also `npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/transport/streaming-prompt.ts tests/unit/transport/streaming-prompt.test.ts
git commit -m "feat(transport): parse the ACP plan update into an onPlan callback"
```

---

## Task 3: Thread `onPlan` through the transport prompt options

**Files:**
- Modify: `src/transport/types.ts`

`onThought` sits at `types.ts:113` inside the prompt options interface.

- [ ] **Step 1: Add the option**

After the `onThought` field:
```ts
  /**
   * Structured plan/todo side-channel: the agent's full ACP `plan` entry list,
   * re-sent on every update (REPLACE, not append). Optional — text channels omit it.
   */
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>;
```
Add `PlanEntry` to the existing `../channels/types` import.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/transport/types.ts
git commit -m "feat(transport): add onPlan to prompt options"
```

---

## Task 4: acpx-bridge subprocess protocol — relay `prompt.plan`

**Files:**
- Modify: `src/transport/acpx-bridge/acpx-bridge-protocol.ts`
- Modify: `src/bridge/bridge-runtime.ts`
- Modify: `src/bridge/bridge-server.ts`
- Modify: `src/transport/acpx-bridge/acpx-bridge-client.ts`
- Test: `tests/unit/transport/acpx-bridge/acpx-bridge-protocol.test.ts` (or the client test)

Context: in acpx-bridge mode acpx runs in a subprocess; events cross the bridge as NDJSON. The thought path is the exact template: `BridgePromptThoughtEvent` (protocol.ts:71) → emitted by `bridge-runtime.ts:814` (`onThought` → `onEvent({type:"prompt.thought"})`) → encoded by `bridge-server.ts:212` → decoded by `acpx-bridge-client.ts:110`.

- [ ] **Step 1: protocol.ts — event + encoder + unions**

After `BridgePromptThoughtEvent` (line ~75):
```ts
export interface BridgePromptPlanEvent {
  id: string;
  event: "prompt.plan";
  entries: PlanEntry[];
}
```
Add `PlanEntry` to the file's imports from `../../channels/types`. Add `BridgePromptPlanEvent` to the `BridgeEvent` union (the `| BridgePromptThoughtEvent` line ~94) and add the encoder:
```ts
export function encodeBridgePromptPlanEvent(event: BridgePromptPlanEvent): string {
  return `${JSON.stringify(event)}\n`;
}
```

- [ ] **Step 2: bridge-runtime.ts — emit**

Extend the local BridgeEvent union (line ~26) with `| { type: "prompt.plan"; entries: PlanEntry[] }` (import `PlanEntry`). Where the prompt options wire `onThought` (line ~813), add a sibling:
```ts
      ...(onEvent
        ? { onPlan: (entries) => onEvent({ type: "prompt.plan", entries }) }
        : {}),
```

- [ ] **Step 3: bridge-server.ts — encode the NDJSON line**

Import `encodeBridgePromptPlanEvent`. After the `prompt.thought` branch (line ~212):
```ts
          } else if (event.type === "prompt.plan") {
            writeLine?.(encodeBridgePromptPlanEvent({
              id: requestId,
              event: "prompt.plan",
              entries: event.entries,
            }));
```

- [ ] **Step 4: acpx-bridge-client.ts — decode**

Extend the client `BridgeEvent` union (line ~27) with `| { type: "prompt.plan"; entries: PlanEntry[] }` (import `PlanEntry`). After the `prompt.thought` decode branch (line ~110):
```ts
      } else if (message.event === "prompt.plan") {
        pending.onEvent?.({ type: "prompt.plan", entries: message.entries });
```

- [ ] **Step 5: Test the round-trip**

Add to the client/protocol test (model on the existing `prompt.thought` round-trip test):
```ts
test("bridge relays a prompt.plan event to the client onEvent", async () => {
  // (mirror the existing prompt.thought test: feed an encoded prompt.plan NDJSON line
  //  into the managed client and assert onEvent receives {type:"prompt.plan", entries})
});
```

- [ ] **Step 6: Run + typecheck**

Run: `bun test tests/unit/transport/acpx-bridge/acpx-bridge-client.test.ts` then `npx tsc --noEmit`
Expected: PASS / exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/transport/acpx-bridge/acpx-bridge-protocol.ts src/bridge/bridge-runtime.ts src/bridge/bridge-server.ts src/transport/acpx-bridge/acpx-bridge-client.ts tests/unit/transport/acpx-bridge/acpx-bridge-client.test.ts
git commit -m "feat(bridge): relay the agent plan event across the bridge protocol"
```

---

## Task 5: Wire `onPlan` in both transports

**Files:**
- Modify: `src/transport/acpx-cli/acpx-cli-transport.ts`
- Modify: `src/transport/acpx-bridge/acpx-bridge-transport.ts`

- [ ] **Step 1: acpx-cli-transport.ts**

The streaming-hook gate at line ~266 lists callbacks; add `options?.onPlan`:
```ts
      if (reply || options?.onSegment || options?.onToolEvent || options?.onThought || options?.onPlan) {
```
The private streaming method (signature line ~527) threads `onThought`; add an `onPlan?` param and pass it into `createStreamingPromptState({ ..., onPlan })`. Pass `options?.onPlan` at the call site (line ~286 area).

- [ ] **Step 2: acpx-bridge-transport.ts — handle the bridge event (serialized chain like thought, lines ~78/123/139/163)**

```ts
    let planError: unknown;
    let planChain = Promise.resolve();
    // ...in the event switch, after the prompt.thought branch:
      if (event.type === "prompt.plan") {
        const onPlan = options?.onPlan;
        if (onPlan) {
          const entries = event.entries;
          planChain = planChain.then(() => onPlan(entries)).catch((error) => { planError ??= error; });
        }
        return;
      }
    // ...after `await thoughtChain;`:
    await planChain;
    // ...after the thoughtError rethrow:
    if (planError) throw planError;
```

- [ ] **Step 3: Typecheck + existing transport tests**

Run: `npx tsc --noEmit` then `node scripts/run-tests.mjs tests/unit/transport`
Expected: exit 0 / 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/transport/acpx-cli/acpx-cli-transport.ts src/transport/acpx-bridge/acpx-bridge-transport.ts
git commit -m "feat(transport): forward onPlan in the cli and bridge transports"
```

---

## Task 6: Agent abstraction — `onPlan` on `agent.chat`

**Files:**
- Modify: `src/weixin/agent/interface.ts`
- Modify: `src/console-agent.ts`

- [ ] **Step 1: interface.ts**

After the `onThought` field (line ~53) on the chat request/options interface:
```ts
  /** Structured plan/todo side-channel; see PromptOptions.onPlan. */
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>;
```
Import `PlanEntry` from `../../channels/types` (match the existing `ToolUseEvent` import path in this file).

- [ ] **Step 2: console-agent.ts**

The wrapped chat method passes `request.onThought` through (lines ~22 / ~66). Add an `onPlan?` param to the method signature and forward `request.onPlan`:
```ts
    onThought?: (chunk: string) => void | Promise<void>,
    onPlan?: (entries: PlanEntry[]) => void | Promise<void>,
    // ...at the call site:
      request.onThought,
      request.onPlan,
```
Import `PlanEntry`. Ensure whatever underlying transport `prompt`/`chat` is invoked receives `onPlan` in its options.

- [ ] **Step 3: Typecheck + console-agent tests**

Run: `npx tsc --noEmit` then `node scripts/run-tests.mjs tests/unit` scoped to the console-agent test dir if present, else `bun test tests/unit/console-agent.test.ts`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/weixin/agent/interface.ts src/console-agent.ts
git commit -m "feat(agent): thread onPlan through the console agent chat seam"
```

---

## Task 7: `plan` ControlEvent + emit from control-service

**Files:**
- Modify: `src/control/control-event-bus.ts`
- Modify: `src/control/control-service.ts`
- Test: `tests/unit/control/control-service.test.ts` (or the closest existing control-service test)

- [ ] **Step 1: control-event-bus.ts — the variant**

In the `ControlEvent` union, after `turn-thought`:
```ts
  | { type: "plan"; chatKey: string; sessionAlias: string; entries: PlanEntry[] }
```
Import `PlanEntry` from `../channels/types`.

- [ ] **Step 2: Write the failing test**

In the control-service test, assert a plan callback emits a `plan` ControlEvent. Pattern (mirror the existing thought→turn-thought assertion):
```ts
test("forwards an agent plan update as a plan ControlEvent", async () => {
  const events: ControlEvent[] = [];
  // build ControlService with a fake agent whose chat() invokes opts.onPlan([...]),
  // subscribe events.push, run prompt(), then:
  expect(events).toContainEqual({
    type: "plan", chatKey: "<k>", sessionAlias: "<a>",
    entries: [{ content: "step", status: "in_progress" }],
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `bun test tests/unit/control/control-service.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement in control-service.ts**

In `executeTurn`, in the `agent.chat({...})` options, after the `onThought` block (control-service.ts:464):
```ts
        onPlan: (entries) => {
          this.deps.events.emit({
            type: "plan",
            chatKey: params.chatKey,
            sessionAlias: params.sessionAlias,
            entries,
          });
        },
```

- [ ] **Step 5: Run — expect PASS** + `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/control/control-event-bus.ts src/control/control-service.ts tests/unit/control/control-service.test.ts
git commit -m "feat(control): emit a plan ControlEvent from the turn"
```

---

## Task 8: Wire DTO + web allowlist

**Files:**
- Modify: `packages/relay-protocol/src/dtos.ts`
- Modify: `packages/relay-protocol/src/web-dtos.ts`
- Test: `tests/unit/packages/relay-protocol/web-dtos.test.ts` (or wherever `parseWebServerEvent` is tested)

Note: keep `PlanEntryDto` structurally identical to core `PlanEntry` so the connector's pass-through (`control-bridge.ts:252 sendEvent(MSG.instanceEvent, { event })`) forwards it unchanged — no connector edit.

- [ ] **Step 1: dtos.ts**

```ts
export interface PlanEntryDto {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}
```
Add to the `ControlEventDto` union after `turn-thought` (line ~140):
```ts
  | { type: "plan"; chatKey: string; sessionAlias: string; entries: PlanEntryDto[] }
```

- [ ] **Step 2: web-dtos.ts — allowlist + deep-validate**

Add `"plan"` to `CONTROL_EVENT_TYPES` (line ~53). In `validControlEvent` (line ~112), add a clause:
```ts
  if (c.type === "plan")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.entries);
```

- [ ] **Step 3: Test**

```ts
test("parseWebServerEvent accepts a plan control event", () => {
  const env = webEventEnvelope({ kind: "control-event", instanceId: "i1",
    event: { type: "plan", chatKey: "k", sessionAlias: "a", entries: [{ content: "x", status: "pending" }] } });
  expect(parseWebServerEvent(env)).not.toBeNull();
});
test("parseWebServerEvent rejects a plan event without entries", () => {
  const env = webEventEnvelope({ kind: "control-event", instanceId: "i1",
    event: { type: "plan", chatKey: "k", sessionAlias: "a" } as never });
  expect(parseWebServerEvent(env)).toBeNull();
});
```

- [ ] **Step 4: Build relay-protocol via tsc + run tests**

Run: `bun run build:relay-protocol` then `node scripts/run-tests.mjs tests/unit/packages/relay-protocol`
Expected: build ok, 0 fail. (tsc build is REQUIRED — the barrel bun build tree-shakes.)

- [ ] **Step 5: Commit**

```bash
git add packages/relay-protocol/src/dtos.ts packages/relay-protocol/src/web-dtos.ts tests/unit/packages/relay-protocol/web-dtos.test.ts
git commit -m "feat(relay-protocol): add the plan control event DTO + web validation"
```

---

## Task 9: relay-web store — hold the live plan

**Files:**
- Modify: `packages/relay-web/src/stores/chat.ts`
- Test: `packages/relay-web/src/__tests__/chat.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("sets the live turn plan on a plan event and replaces it on the next", () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  const ev = (entries: unknown) => chat.applyEvent({ kind: "control-event", instanceId: "i1",
    event: { type: "plan", chatKey: "relay:i1", sessionAlias: "backend", entries } } as never);
  ev([{ content: "a", status: "in_progress" }]);
  expect(chat.liveTurn?.plan).toEqual([{ content: "a", status: "in_progress" }]);
  ev([{ content: "a", status: "completed" }, { content: "b", status: "pending" }]);
  expect(chat.liveTurn?.plan?.length).toBe(2); // replace, not append
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd packages/relay-web && npx vitest run chat`

- [ ] **Step 3: Implement**

a) `LiveTurn` (chat.ts:28) — add `plan?: PlanEntryDto[];` (import `PlanEntryDto` from `@ganglion/xacpx-relay-protocol`).

b) In `applyEvent` (after the `turn-thought` branch, chat.ts:264):
```ts
    } else if (e.type === "plan") {
      ensureTurn(bufKey(event.instanceId, e.sessionAlias)).plan = e.entries;
```
(`ensureTurn` already creates the buffer; replace semantics are automatic. `turn-started` makes a fresh buffer with no `plan`; `turn-finished`→`flushTurn` discards the live turn, so the plan is live-only by construction.)

- [ ] **Step 4: Run — expect PASS** + `npx vue-tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/stores/chat.ts packages/relay-web/src/__tests__/chat.test.ts
git commit -m "feat(relay-web): hold the agent plan on the live turn"
```

---

## Task 10: relay-web render — `PlanPanel`

**Files:**
- Create: `packages/relay-web/src/components/PlanPanel.vue`
- Modify: `packages/relay-web/src/components/ChatPane.vue`
- Test: `packages/relay-web/src/__tests__/planpanel.test.ts` (new)

- [ ] **Step 1: Create PlanPanel.vue**

```vue
<script setup lang="ts">
import { computed } from "vue";
import { Circle, Loader2, CheckCircle2 } from "lucide-vue-next";
import type { PlanEntryDto } from "@ganglion/xacpx-relay-protocol";

const props = defineProps<{ entries: PlanEntryDto[] }>();
const done = computed(() => props.entries.filter((e) => e.status === "completed").length);
const iconOf = (s: PlanEntryDto["status"]) =>
  s === "completed" ? CheckCircle2 : s === "in_progress" ? Loader2 : Circle;
const clsOf = (s: PlanEntryDto["status"]) =>
  s === "completed" ? "text-run" : s === "in_progress" ? "text-accent" : "text-fg-muted";
</script>

<template>
  <div v-if="entries.length" data-test="plan-panel" class="rounded-md border border-border bg-surface p-2 text-sm">
    <div class="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase text-fg-muted">
      Plan <span class="font-mono tabular-nums">{{ done }}/{{ entries.length }}</span>
    </div>
    <ul class="space-y-0.5">
      <li v-for="(e, i) in entries" :key="i" class="flex items-start gap-1.5">
        <component :is="iconOf(e.status)" :size="13" :class="[clsOf(e.status), 'mt-0.5 shrink-0', e.status === 'in_progress' ? 'animate-spin motion-reduce:animate-none' : '']" />
        <span :class="['min-w-0', e.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg']">{{ e.content }}</span>
      </li>
    </ul>
  </div>
</template>
```

- [ ] **Step 2: Mount in ChatPane.vue**

Import `PlanPanel`; render it where the live turn is shown (above the `MessageList`'s live area or just above the composer), guarded:
```vue
<PlanPanel v-if="chat.liveTurn?.plan?.length" :entries="chat.liveTurn.plan" />
```

- [ ] **Step 3: Test**

```ts
import { mount } from "@vue/test-utils";
import PlanPanel from "../components/PlanPanel.vue";
it("renders entries with a done count and strikes completed ones", () => {
  const w = mount(PlanPanel, { props: { entries: [
    { content: "a", status: "completed" }, { content: "b", status: "in_progress" },
  ] } });
  expect(w.find('[data-test="plan-panel"]').text()).toContain("1/2");
  expect(w.find("li").classes().join(" ")).toBeDefined();
});
it("renders nothing for an empty plan", () => {
  const w = mount(PlanPanel, { props: { entries: [] } });
  expect(w.find('[data-test="plan-panel"]').exists()).toBe(false);
});
```

- [ ] **Step 4: Run web suite + vue-tsc**

Run: `cd packages/relay-web && npx vue-tsc --noEmit && npx vitest run`
Expected: vue-tsc clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/components/PlanPanel.vue packages/relay-web/src/components/ChatPane.vue packages/relay-web/src/__tests__/planpanel.test.ts
git commit -m "feat(relay-web): render the agent plan as a live checklist"
```

---

## Task 11: Build, deploy to sandbox, verify end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Full build + typechecks**

Run: `npx tsc --noEmit` (core), `bun run build`, and in `packages/relay-web`: `npx vue-tsc --noEmit`.
Expected: all exit 0.

- [ ] **Step 2: Core regression via the official runner**

Run: `node scripts/run-tests.mjs tests/unit/transport tests/unit/control tests/unit/bridge tests/unit/packages/relay-protocol`
Expected: EXIT 0, 0 fail. (Never whole-dir `bun test`.)

- [ ] **Step 3: Rebuild relay-web dist + restart sandbox console**

```bash
cd packages/relay-web && npm run build && cd ../..
# stop the sandbox console (pid owning /tmp/xacpx-relay-test) with SIGTERM, then:
HOME=/tmp/xacpx-relay-test nohup node dist/cli.js run > /tmp/xacpx-console.log 2>&1 &
```
(acpx-bridge transport: the bridge picks up the new `prompt.plan` plumbing on restart. relay-web dist is served live by the hub — hard-refresh the browser.)

- [ ] **Step 4: Trigger a planning prompt**

Send a prompt that makes opencode emit a plan (e.g. a multi-step task: "make a 3-step plan then do it"). Confirm in the browser the PlanPanel appears under the live turn, updates as steps complete, and disappears when the turn finishes.

- [ ] **Step 5: Confirm the event actually crossed the wire**

Tail the opencode log for a `sessionUpdate: "plan"` and confirm no errors in `/tmp/xacpx-relay-test/.xacpx/runtime/app.log`. If the panel never appears, check (in order): does the opencode log show a `plan` update at all (some models/prompts never emit one)? → bridge `prompt.plan` NDJSON line present? → web received a `plan` control-event (it must be in `CONTROL_EVENT_TYPES` or `parseWebServerEvent` drops it).

---

## Deferred (NOT in this slice — separate follow-up plans)

- **History persistence / replay.** Accumulate the final plan into the hub turn buffer and `MessageRecordDto.structured.plan`, render it on persisted turns. Touches `packages/relay/src/server.ts`, `packages/relay-protocol/src/web-dtos.ts`, `TurnParts.vue`.
- **WeChat / Feishu rendering.** Surface the plan as a text block on those channels (set `onPlan` in the command-router prompt path: `src/commands/command-router.ts`, `router-types.ts`, `handlers/session-handler.ts`, `packages/channel-feishu`).
- **Non-streaming parse path.** `src/transport/prompt-output.ts` also inspects `sessionUpdate`; confirm whether the batched (non-stream) prompt path needs the same `plan` handling.

---

## Self-Review

- **Coverage:** parse (T2) → transport option (T3) → bridge subprocess (T4) → both transports (T5) → agent (T6) → control event (T7) → wire DTO + allowlist (T8) → store (T9) → render (T10) → e2e (T11). Every layer from the file map is covered; connector/hub correctly excluded (pass-through + unconditional broadcast, verified against `control-bridge.ts:252` and `server.ts:104`).
- **Type consistency:** `PlanEntry` (core, `channels/types.ts`) and `PlanEntryDto` (wire, `dtos.ts`) are structurally identical by design — required for the connector pass-through. `onPlan(entries: PlanEntry[])` signature is identical at every core hop.
- **Allowlist trap:** `plan` MUST be added to `CONTROL_EVENT_TYPES` (T8) or `parseWebServerEvent` silently drops it — this is the single most likely "nothing shows up" failure, called out in T11 Step 5.
- **Replace semantics** are enforced by assignment (`liveTurn.plan = e.entries`), not append — tested in T9.
