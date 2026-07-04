# File edit & save (relay-web file viewer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user edit a text file's content in the relay-web file viewer and write it back to disk on the instance host, with a code editor, stale-write protection, and an unsaved-changes guard.

**Architecture:** A new gated `control.fs.write` RPC crosses the protocol, the core backend (`WorkspaceFs`/`ControlService`), and the connector dispatch. The web adds a CodeMirror 6 editor mounted in place of the read-only Shiki view; the file read now carries an `{mtimeMs,size}` token that the write echoes so a concurrent agent edit is rejected, not overwritten. The per-file editor stays mounted (v-show) so its draft survives tab switches; center-tabs only tracks a `dirty` flag for the close guard.

**Tech Stack:** TypeScript, Vue 3 `<script setup>`, Pinia, Tailwind v3, Vite/vitest (web); Bun test + `write-file-atomic` (backend); `@ganglion/xacpx-relay-protocol` (tsc-built wire types); CodeMirror 6.

## Global Constraints

- **Package manager:** Bun for builds; `npm install --package-lock-only` to sync the root `package-lock.json` after any `packages/*` dependency change (CI `npm ci` fails otherwise). `bun.lock` needs no manual edit.
- **Protocol dist is tsc-built, not bun.** After editing `packages/relay-protocol/src`, rebuild with `bun run build:relay-protocol` (it runs bun bundle + `tsc` + `assert:relay-protocol`). A bun-only barrel build tree-shakes exports to empty.
- **Backend tests run under Bun**, one file at a time: `bun test tests/unit/control/<file>.test.ts` (whole-dir runs leak module state and false-fail).
- **Web tests run under vitest from the package dir**, never `bun test`: `cd packages/relay-web && npx vitest run src/__tests__/<file>.test.ts`. The persistent shell cwd drifts back to repo root after a `cd repo && git …`; always re-`cd packages/relay-web` before a vitest/vue-tsc command or it runs in a node env and false-fails with "document is not defined".
- **Web typecheck:** `cd packages/relay-web && npx vue-tsc --noEmit`.
- **CSS theme tokens** are `rgb(var(--c-fg))`, `--c-fg-muted`, `--c-raised`, `--c-border`, `--c-accent`, `--c-surface`, `--c-bg`; mono font is `"JetBrains Mono", ui-monospace, monospace`.
- **Safety invariants (never regress):** binary files are not editable; truncated reads are not saveable; files over `LINE_GUTTER_LIMIT` (5000) lines do not enter the editor; the write RPC is gated by `filesWriteEnabled()`; a save whose `{mtimeMs,size}` token no longer matches disk is rejected with `stale-write`.
- **`git add` explicit paths only** — never `git add -A` (subagents must not sweep in unrelated files).
- **i18n parity:** every key added to `messages/en.ts` must also be added to `messages/zh-CN.ts` (the `i18n-parity` test enforces this).

---

### Task 1: Protocol — `control.fs.write` message, payloads, and `mtimeMs` on the read result

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts` (MSG map ~line 43; `FsReadResult` ~line 325; add payloads near `FsDownloadResult` ~line 414)
- Rebuild: `packages/relay-protocol/dist` via `bun run build:relay-protocol`

**Interfaces:**
- Produces:
  - `MSG.fsWrite = "control.fs.write"`
  - `interface FsWritePayload { workspace: string; path: string; content: string; expected: { mtimeMs: number; size: number } }`
  - `interface FsWriteResult { path: string; mtimeMs: number; size: number }`
  - `FsReadResult` gains `mtimeMs: number`

- [ ] **Step 1: Add the message name.** In `packages/relay-protocol/src/messages.ts`, in the `MSG` object, add after the `fsDownload` line (line 43):

```ts
  fsDownload: "control.fs.download",
  fsWrite: "control.fs.write",
```

- [ ] **Step 2: Add `mtimeMs` to `FsReadResult`.** In the same file, extend the `FsReadResult` interface (the block starting `export interface FsReadResult {`):

```ts
export interface FsReadResult {
  workspace: string;
  path: string;
  /** UTF-8 content (possibly truncated). Empty when `binary` is true. */
  content: string;
  /** Total file size in bytes. */
  size: number;
  /** Filesystem mtime in ms; paired with `size` as a stale-write token for editing. */
  mtimeMs: number;
  /** True when the file exceeded the read cap and `content` is a prefix. */
  truncated: boolean;
  /** True when the file looks binary; `content` is then empty. */
  binary: boolean;
}
```

- [ ] **Step 3: Add the write payload/result types.** In the same file, immediately after the `FsDownloadResult` interface (ends ~line 414), add:

```ts
export interface FsWritePayload {
  workspace: string;
  path: string;
  /** Full new UTF-8 file content. */
  content: string;
  /** Stale-write token captured at read time; the write is rejected if disk no longer matches. */
  expected: { mtimeMs: number; size: number };
}
export interface FsWriteResult {
  path: string;
  mtimeMs: number;
  size: number;
}
```

- [ ] **Step 4: Rebuild the protocol dist and assert exports.**

Run: `bun run build:relay-protocol`
Expected: ends with `relay-protocol dist exports OK` (the `assert:relay-protocol` step). No TS errors.

- [ ] **Step 5: Commit.**

```bash
git add packages/relay-protocol/src/messages.ts packages/relay-protocol/dist
git commit -m "feat(relay-protocol): add control.fs.write message + FsReadResult.mtimeMs"
```

---

### Task 2: Backend — `WorkspaceFs.readFile` returns `mtimeMs`; new `WorkspaceFs.writeFile`

**Files:**
- Modify: `src/control/workspace-fs.ts` (`FileContent` ~line 56; `readFile` ~line 296; add `writeFile` after `readFile`)
- Test: `tests/unit/control/workspace-fs-writes.test.ts` (append)

**Interfaces:**
- Consumes: `MSG`/types from Task 1 are not imported here (this file has its own `FileContent`).
- Produces:
  - `FileContent` gains `mtimeMs: number`
  - `async writeFile(workspace: string, relPath: string, content: string, expected: { mtimeMs: number; size: number }): Promise<{ path: string; mtimeMs: number; size: number }>`
  - Error strings: `not-a-file`, `is-binary`, `file-too-large`, `stale-write` (plus inherited `not-found`, `path-escapes-workspace`, `path-must-be-relative` from `resolve`).

- [ ] **Step 1: Write the failing tests.** Append to `tests/unit/control/workspace-fs-writes.test.ts`:

```ts
import { stat, readFile as readFileFs } from "node:fs/promises";

test("readFile returns an mtimeMs token", async () => {
  const r = await fs.readFile("ws", "a.txt");
  expect(typeof r.mtimeMs).toBe("number");
  expect(r.mtimeMs).toBeGreaterThan(0);
});

test("writeFile saves new content when the token matches", async () => {
  const before = await fs.readFile("ws", "a.txt");
  const res = await fs.writeFile("ws", "a.txt", "goodbye", { mtimeMs: before.mtimeMs, size: before.size });
  expect(res.path).toBe("a.txt");
  expect(await readFileFs(join(rootDir, "a.txt"), "utf8")).toBe("goodbye");
  const onDisk = await stat(join(rootDir, "a.txt"));
  expect(res.mtimeMs).toBe(onDisk.mtimeMs);
  expect(res.size).toBe(onDisk.size);
});

test("writeFile rejects a stale token (size changed on disk)", async () => {
  const before = await fs.readFile("ws", "a.txt");
  await writeFile(join(rootDir, "a.txt"), "changed-by-agent");
  await expect(
    fs.writeFile("ws", "a.txt", "mine", { mtimeMs: before.mtimeMs, size: before.size }),
  ).rejects.toThrow("stale-write");
});

test("writeFile rejects a path that escapes the workspace", async () => {
  await expect(
    fs.writeFile("ws", "../escape.txt", "x", { mtimeMs: 1, size: 1 }),
  ).rejects.toThrow();
});

test("writeFile rejects a directory target", async () => {
  await expect(
    fs.writeFile("ws", "sub", "x", { mtimeMs: 1, size: 1 }),
  ).rejects.toThrow("not-a-file");
});

test("writeFile rejects content containing a NUL byte", async () => {
  const before = await fs.readFile("ws", "a.txt");
  await expect(
    fs.writeFile("ws", "a.txt", "a\u0000b", { mtimeMs: before.mtimeMs, size: before.size }),
  ).rejects.toThrow("is-binary");
});

test("writeFile rejects content over the size cap", async () => {
  const before = await fs.readFile("ws", "a.txt");
  const huge = "x".repeat(256 * 1024 + 1);
  await expect(
    fs.writeFile("ws", "a.txt", huge, { mtimeMs: before.mtimeMs, size: before.size }),
  ).rejects.toThrow("file-too-large");
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun test tests/unit/control/workspace-fs-writes.test.ts`
Expected: FAIL — `writeFile` is not a function / `mtimeMs` is undefined.

- [ ] **Step 3: Add the `write-file-atomic` import.** At the top of `src/control/workspace-fs.ts`, after the existing `node:fs/promises` import (line 4), add:

```ts
import writeFileAtomic from "write-file-atomic";
```

- [ ] **Step 4: Add `mtimeMs` to `FileContent` and return it from `readFile`.** In the `FileContent` interface (line 56), add `mtimeMs: number;` after `size: number;`:

```ts
export interface FileContent {
  workspace: string;
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
  truncated: boolean;
  binary: boolean;
}
```

In `readFile` (line 296), add `mtimeMs: info.mtimeMs,` to the returned object (after `size: info.size,`):

```ts
      return {
        workspace,
        path: rel,
        content: binary ? "" : slice.toString("utf8"),
        size: info.size,
        mtimeMs: info.mtimeMs,
        truncated: info.size > FILE_READ_CAP,
        binary,
      };
```

- [ ] **Step 5: Add the `writeFile` method.** Insert immediately after the `readFile` method's closing brace (after line 317) in `src/control/workspace-fs.ts`:

```ts
  /** Overwrite an EXISTING file's content, guarded by a stale-write token. The target must
   *  resolve inside the workspace (realpath containment), be a regular file, and match the
   *  caller's `{mtimeMs,size}` token — otherwise `stale-write`. Content must be UTF-8 text
   *  (no NUL) and within the read cap. Writes atomically. Returns a fresh token. */
  async writeFile(
    workspace: string,
    relPath: string,
    content: string,
    expected: { mtimeMs: number; size: number },
  ): Promise<{ path: string; mtimeMs: number; size: number }> {
    const { abs, rel } = await this.resolve(workspace, relPath); // realpath + containment; throws not-found if missing
    const info = await stat(abs);
    if (!info.isFile()) throw new Error("not-a-file");
    if (content.includes("\u0000")) throw new Error("is-binary");
    if (Buffer.byteLength(content, "utf8") > FILE_READ_CAP) throw new Error("file-too-large");
    if (info.mtimeMs !== expected.mtimeMs || info.size !== expected.size) throw new Error("stale-write");
    await writeFileAtomic(abs, content);
    const after = await stat(abs);
    return { path: rel, mtimeMs: after.mtimeMs, size: after.size };
  }
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `bun test tests/unit/control/workspace-fs-writes.test.ts`
Expected: PASS (all, including the pre-existing create/rename cases).

- [ ] **Step 7: Commit.**

```bash
git add src/control/workspace-fs.ts tests/unit/control/workspace-fs-writes.test.ts
git commit -m "feat(control): WorkspaceFs.writeFile with stale-write token + mtimeMs on readFile"
```

---

### Task 3: Backend — `ControlService.fsWrite` (gated) + connector dispatch

**Files:**
- Modify: `src/control/control-service.ts` (add `fsWrite` after `fsCopy` ~line 225)
- Modify: `packages/channel-relay/src/control-bridge.ts` (import `FsWritePayload`; add `case MSG.fsWrite` after the `fsDownload` case ~line 254)
- Test: `tests/unit/control/control-service-files-gate.test.ts` (append)

**Interfaces:**
- Consumes: `WorkspaceFs.writeFile` (Task 2); `MSG.fsWrite`, `FsWritePayload` (Task 1); `this.deps.filesWriteEnabled()`.
- Produces: `ControlService.fsWrite(workspace, path, content, expected): Promise<{ path; mtimeMs; size }>`.

- [ ] **Step 1: Write the failing gate test.** Append to `tests/unit/control/control-service-files-gate.test.ts`:

```ts
test("fsWrite is rejected with files-write-disabled when the gate is off", async () => {
  const svc = make(false, []);
  await expect(
    svc.fsWrite("ws", "x.txt", "hello", { mtimeMs: 1, size: 1 }),
  ).rejects.toThrow("files-write-disabled");
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/unit/control/control-service-files-gate.test.ts`
Expected: FAIL — `svc.fsWrite is not a function`.

- [ ] **Step 3: Add `fsWrite` to `ControlService`.** In `src/control/control-service.ts`, after the `fsCopy` method (ends ~line 225, before `fsDownload`), add:

```ts
  async fsWrite(
    workspace: string,
    path: string,
    content: string,
    expected: { mtimeMs: number; size: number },
  ): Promise<{ path: string; mtimeMs: number; size: number }> {
    if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled");
    return this.workspaceFs.writeFile(workspace, path, content, expected);
  }
```

- [ ] **Step 4: Run the gate test to verify it passes.**

Run: `bun test tests/unit/control/control-service-files-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the connector dispatch case.** In `packages/channel-relay/src/control-bridge.ts`, add `FsWritePayload` to the `@ganglion/xacpx-relay-protocol` type import (the block that already imports `FsDownloadPayload`, `FsCreatePayload`, etc.). Then after the `case MSG.fsDownload:` block (ends ~line 254), add:

```ts
    case MSG.fsWrite: {
      const i = payload as FsWritePayload;
      if (!i.workspace || !i.path) return errorPayload("bad-request", "workspace and path are required");
      if (typeof i.content !== "string") return errorPayload("bad-request", "content must be a string");
      if (!i.expected || typeof i.expected.mtimeMs !== "number" || typeof i.expected.size !== "number") {
        return errorPayload("bad-request", "expected {mtimeMs,size} is required");
      }
      return await control.fsWrite(i.workspace, i.path, i.content, i.expected);
    }
```

- [ ] **Step 6: Typecheck core + connector.**

Run: `npx tsc --noEmit && npx tsc -p packages/channel-relay/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add src/control/control-service.ts packages/channel-relay/src/control-bridge.ts tests/unit/control/control-service-files-gate.test.ts
git commit -m "feat(control,channel-relay): gated fsWrite RPC + connector dispatch"
```

---

### Task 4: Web store — `files.saveFile`

**Files:**
- Modify: `packages/relay-web/src/stores/files.ts` (import `FsWriteResult` ~line 9; add `saveFile` near `readFile` ~line 370; export it ~line 386)
- Test: `packages/relay-web/src/__tests__/files.test.ts` (append)

**Interfaces:**
- Consumes: `api.rpc`, `unwrap`, `FsWriteResult` (Task 1).
- Produces: `saveFile(id: string, ws: string, filePath: string, content: string, expected: { mtimeMs: number; size: number }): Promise<FsWriteResult>`.

- [ ] **Step 1: Write the failing test.** Append to `packages/relay-web/src/__tests__/files.test.ts` (mirror how existing tests in this file stub `api.rpc`; the store module exports `useFilesStore`). Add:

```ts
test("saveFile sends control.fs.write with the content and expected token", async () => {
  const rpc = vi.fn().mockResolvedValue({ path: "a.ts", mtimeMs: 222, size: 3 });
  vi.mocked(api.rpc).mockImplementation(rpc);
  const store = useFilesStore();
  const res = await store.saveFile("inst1", "ws", "a.ts", "new", { mtimeMs: 111, size: 2 });
  expect(rpc).toHaveBeenCalledWith("inst1", "control.fs.write", {
    workspace: "ws", path: "a.ts", content: "new", expected: { mtimeMs: 111, size: 2 },
  });
  expect(res).toEqual({ path: "a.ts", mtimeMs: 222, size: 3 });
});
```

> If `files.test.ts` does not already import `api`/`vi.mock("../lib/client")`, copy the mock setup from the top of the existing file (it already mocks the rpc client for the `readFile` tests). Use the exact same import path the existing tests use.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd packages/relay-web && npx vitest run src/__tests__/files.test.ts`
Expected: FAIL — `store.saveFile is not a function`.

- [ ] **Step 3: Import the type.** In `packages/relay-web/src/stores/files.ts`, add `type FsWriteResult,` to the `@ganglion/xacpx-relay-protocol` import block (alongside `type FsReadResult,`).

- [ ] **Step 4: Add the `saveFile` action.** After the `readFile` function (ends ~line 372), add:

```ts
  /** Overwrite a file's content, echoing the read-time stale-write token. Throws the raw
   *  error code (`stale-write` / `files-write-disabled` / `is-binary` / `file-too-large`)
   *  so the caller can map it to a message. */
  async function saveFile(
    id: string, ws: string, filePath: string, content: string, expected: { mtimeMs: number; size: number },
  ): Promise<FsWriteResult> {
    return unwrap(await api.rpc<FsWriteResult>(id, "control.fs.write", { workspace: ws, path: filePath, content, expected }));
  }
```

- [ ] **Step 5: Export it.** In the store's `return { … }` (line ~386), add `saveFile,` next to `readFile, readDiff,`.

- [ ] **Step 6: Run the test to verify it passes.**

Run: `cd packages/relay-web && npx vitest run src/__tests__/files.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/relay-web/src/stores/files.ts packages/relay-web/src/__tests__/files.test.ts
git commit -m "feat(relay-web): files store saveFile action"
```

---

### Task 5: Web — `CodeEditor.vue` (CodeMirror 6 wrapper) + dependency

**Files:**
- Create: `packages/relay-web/src/components/CodeEditor.vue`
- Modify: `packages/relay-web/package.json` (add CodeMirror deps)
- Modify: root `package-lock.json` (via `npm install --package-lock-only`)
- Test: `packages/relay-web/src/__tests__/codeeditor.test.ts` (create)

**Interfaces:**
- Produces: `CodeEditor` component. Props `{ modelValue: string; filename?: string }`. Emits `update:modelValue` (string) and `save` (no payload, from Mod-S). Pure editor — no I/O.

- [ ] **Step 1: Add the dependencies.** In `packages/relay-web/package.json` `dependencies`, add (keep alphabetical grouping loose — the exact caret versions can be whatever `npm` resolves latest 6.x):

```json
    "@codemirror/commands": "^6.0.0",
    "@codemirror/lang-css": "^6.0.0",
    "@codemirror/lang-html": "^6.0.0",
    "@codemirror/lang-javascript": "^6.0.0",
    "@codemirror/lang-json": "^6.0.0",
    "@codemirror/lang-markdown": "^6.0.0",
    "@codemirror/lang-python": "^6.0.0",
    "@codemirror/lang-vue": "^0.1.0",
    "@codemirror/lang-yaml": "^6.0.0",
    "@codemirror/state": "^6.0.0",
    "@codemirror/view": "^6.0.0",
    "codemirror": "^6.0.0",
```

- [ ] **Step 2: Install and sync locks.**

Run: `cd packages/relay-web && bun install && cd ../.. && npm install --package-lock-only`
Expected: `bun.lock` and root `package-lock.json` updated; no errors.

- [ ] **Step 3: Write the failing test.** Create `packages/relay-web/src/__tests__/codeeditor.test.ts`:

```ts
import { describe, test, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import CodeEditor from "../components/CodeEditor.vue";

describe("CodeEditor", () => {
  test("renders the initial content into the CodeMirror document", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "hello world", filename: "a.ts" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.element.textContent).toContain("hello world");
    w.unmount();
  });

  test("emits update:modelValue when the document changes", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "a", filename: "a.txt" } });
    await new Promise((r) => setTimeout(r, 0));
    // Access the exposed view to dispatch a change (component exposes `view` for testing).
    const view = (w.vm as unknown as { view: { dispatch: (t: unknown) => void; state: { doc: { length: number } } } }).view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "b" } });
    await new Promise((r) => setTimeout(r, 0));
    const events = w.emitted("update:modelValue");
    expect(events?.at(-1)?.[0]).toBe("ab");
    w.unmount();
  });
});
```

- [ ] **Step 4: Run it to verify it fails.**

Run: `cd packages/relay-web && npx vitest run src/__tests__/codeeditor.test.ts`
Expected: FAIL — cannot resolve `../components/CodeEditor.vue`.

- [ ] **Step 5: Create the component.** Write `packages/relay-web/src/components/CodeEditor.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { vue } from "@codemirror/lang-vue";

// A thin CodeMirror 6 wrapper: value in via v-model, save out via Mod-S. It owns NO file
// I/O — the parent (FileViewer) loads/saves. Kept a separate component so CM6 (a sizeable
// dependency) can be lazily chunked and so the editor is testable in isolation.
const props = defineProps<{ modelValue: string; filename?: string }>();
const emit = defineEmits<{ "update:modelValue": [string]; save: [] }>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;

function langFor(name?: string): Extension[] {
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": return [javascript({ jsx: ext === "jsx" })];
    case "ts": return [javascript({ typescript: true })];
    case "tsx": return [javascript({ typescript: true, jsx: true })];
    case "json": return [json()];
    case "html": case "htm": return [html()];
    case "css": case "scss": case "less": return [css()];
    case "md": case "markdown": return [markdown()];
    case "py": return [python()];
    case "yaml": case "yml": return [yaml()];
    case "vue": return [vue()];
    default: return [];
  }
}

// Theme mapped to the dashboard's CSS tokens so light/dark match without a second theme dep.
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "rgb(var(--c-fg))", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono", ui-monospace, monospace', lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "transparent", color: "rgb(var(--c-fg-muted))", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgb(var(--c-raised) / 0.5)" },
  ".cm-activeLineGutter": { backgroundColor: "rgb(var(--c-raised) / 0.5)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgb(var(--c-accent) / 0.25)" },
  ".cm-cursor": { borderLeftColor: "rgb(var(--c-accent))" },
});

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        theme,
        ...langFor(props.filename),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { emit("save"); return true; } }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
        }),
      ],
    }),
  });
});

// Reconcile an external value change (e.g. after a successful save re-reads) without
// clobbering in-progress typing: only replace when the prop differs from the current doc.
watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  }
});

onBeforeUnmount(() => { view?.destroy(); view = null; });

// Exposed for tests (dispatch changes directly). Not part of the public contract.
defineExpose({ get view() { return view; } });
</script>

<template>
  <div ref="host" data-test="code-editor" class="h-full w-full overflow-auto"></div>
</template>
```

- [ ] **Step 6: Run the test to verify it passes.**

Run: `cd packages/relay-web && npx vitest run src/__tests__/codeeditor.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck.**

Run: `cd packages/relay-web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit.**

```bash
git add packages/relay-web/package.json packages/relay-web/bun.lock package-lock.json packages/relay-web/src/components/CodeEditor.vue packages/relay-web/src/__tests__/codeeditor.test.ts
git commit -m "feat(relay-web): CodeEditor CodeMirror 6 wrapper"
```

---

### Task 6: Web — center-tabs dirty flag + guarded close

**Files:**
- Modify: `packages/relay-web/src/stores/center-tabs.ts` (extend the file tab type; add `setDirty`, `isDirty`, `closeTabGuarded`; export them)
- Test: `packages/relay-web/src/__tests__/center-tabs.test.ts` (append)

**Interfaces:**
- Consumes: existing store.
- Produces:
  - file tab type gains `dirty?: boolean`
  - `setDirty(key: string, id: string, dirty: boolean): void`
  - `isDirty(key: string, id: string): boolean`
  - `closeTabGuarded(key: string, id: string, confirm: () => boolean): boolean` — closes; when the tab is dirty and `confirm()` returns false, it is a no-op returning `false`; otherwise closes and returns `true`.

- [ ] **Step 1: Write the failing tests.** Append to `packages/relay-web/src/__tests__/center-tabs.test.ts`:

```ts
test("setDirty/isDirty track a file tab's unsaved state", () => {
  const s = useCenterTabsStore();
  const key = sessionKey("i1", "a");
  s.openFile(key, "src/x.ts");
  expect(s.isDirty(key, "file:src/x.ts")).toBe(false);
  s.setDirty(key, "file:src/x.ts", true);
  expect(s.isDirty(key, "file:src/x.ts")).toBe(true);
});

test("closeTabGuarded closes a clean tab without asking", () => {
  const s = useCenterTabsStore();
  const key = sessionKey("i1", "a");
  s.openFile(key, "src/x.ts");
  const confirm = vi.fn(() => false);
  expect(s.closeTabGuarded(key, "file:src/x.ts", confirm)).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  expect(s.tabsFor(key).some((t) => t.id === "file:src/x.ts")).toBe(false);
});

test("closeTabGuarded blocks a dirty tab when confirm is declined", () => {
  const s = useCenterTabsStore();
  const key = sessionKey("i1", "a");
  s.openFile(key, "src/x.ts");
  s.setDirty(key, "file:src/x.ts", true);
  expect(s.closeTabGuarded(key, "file:src/x.ts", () => false)).toBe(false);
  expect(s.tabsFor(key).some((t) => t.id === "file:src/x.ts")).toBe(true);
  expect(s.closeTabGuarded(key, "file:src/x.ts", () => true)).toBe(true);
  expect(s.tabsFor(key).some((t) => t.id === "file:src/x.ts")).toBe(false);
});
```

> Ensure `vi` is imported at the top of `center-tabs.test.ts` (`import { … vi } from "vitest"`), matching the existing import list.

- [ ] **Step 2: Run to verify failure.**

Run: `cd packages/relay-web && npx vitest run src/__tests__/center-tabs.test.ts`
Expected: FAIL — `s.isDirty is not a function`.

- [ ] **Step 3: Extend the file tab type.** In `packages/relay-web/src/stores/center-tabs.ts`, add `dirty?: boolean` to the file variant of `CenterTab`:

```ts
  | { kind: "file"; id: string; path: string; targetLine?: number; targetRev?: number; dirty?: boolean }
```

- [ ] **Step 4: Add the actions.** Inside `useCenterTabsStore`, before the `return { … }`, add:

```ts
  function setDirty(key: string, id: string, dirty: boolean): void {
    const current = bySession.value[key];
    if (!current) return;
    const tabs = current.tabs.map((t) => (t.id === id && t.kind === "file" ? { ...t, dirty } : t));
    bySession.value = { ...bySession.value, [key]: { tabs, activeId: current.activeId } };
  }

  function isDirty(key: string, id: string): boolean {
    const t = bySession.value[key]?.tabs.find((x) => x.id === id);
    return !!(t && t.kind === "file" && t.dirty);
  }

  /** Close `id`, but if it holds unsaved edits, ask `confirm()` first. Returns whether the
   *  tab was closed. `confirm` is injected (the store cannot show UI) — callers pass e.g.
   *  `() => window.confirm(t("files.unsavedConfirm"))`. */
  function closeTabGuarded(key: string, id: string, confirm: () => boolean): boolean {
    if (isDirty(key, id) && !confirm()) return false;
    closeTab(key, id);
    return true;
  }
```

- [ ] **Step 5: Export the actions.** Add `setDirty, isDirty, closeTabGuarded,` to the store's `return { … }`.

- [ ] **Step 6: Run to verify pass.**

Run: `cd packages/relay-web && npx vitest run src/__tests__/center-tabs.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/relay-web/src/stores/center-tabs.ts packages/relay-web/src/__tests__/center-tabs.test.ts
git commit -m "feat(relay-web): center-tabs dirty flag + guarded close"
```

---

### Task 7: Web — FileViewer edit mode + wiring + i18n

**Files:**
- Modify: `packages/relay-web/src/components/FileViewer.vue`
- Modify: `packages/relay-web/src/views/DashboardView.vue` (bind `@dirty-change`; route closes through `closeTabGuarded`)
- Modify: `packages/relay-web/src/components/CenterTabStrip.vue` (dirty dot; guarded close)
- Modify: `packages/relay-web/src/i18n/messages/en.ts` and `messages/zh-CN.ts`
- Test: `packages/relay-web/src/__tests__/fileviewer.test.ts` (append)

**Interfaces:**
- Consumes: `files.saveFile` (Task 4), `CodeEditor` (Task 5), `centerTabs.setDirty`/`closeTabGuarded` (Task 6), `FsReadResult.mtimeMs` (Task 1).
- Produces: FileViewer emits `dirty-change: [boolean]` (in addition to existing `back`, `close`).

- [ ] **Step 1: Write the failing tests.** Append to `packages/relay-web/src/__tests__/fileviewer.test.ts`. Reuse the file's existing mount helper and store mock (it already mocks `files.readFile` and `../lib/shiki`). Add a `saveFile` mock to the files-store stub if not present.

```ts
test("Edit enters edit mode and Save calls saveFile with the read token", async () => {
  // readFile returns a small text file with an mtime token.
  readFileMock.mockResolvedValue({ workspace: "ws", path: "a.ts", content: "old", size: 3, mtimeMs: 100, truncated: false, binary: false });
  const saveFile = vi.fn().mockResolvedValue({ path: "a.ts", mtimeMs: 200, size: 3 });
  filesStore.saveFile = saveFile;
  const w = mountViewer({ path: "a.ts" });
  await flush();
  await w.get('[data-test="fv-edit"]').trigger("click");
  expect(w.find('[data-test="code-editor"]').exists()).toBe(true);
  await w.get('[data-test="fv-save"]').trigger("click");
  await flush();
  expect(saveFile).toHaveBeenCalledWith("inst1", "ws", "a.ts", "old", { mtimeMs: 100, size: 3 });
});

test("Edit button is hidden for binary/truncated files", async () => {
  readFileMock.mockResolvedValue({ workspace: "ws", path: "big.bin", content: "", size: 9e9, mtimeMs: 1, truncated: true, binary: true });
  const w = mountViewer({ path: "big.bin" });
  await flush();
  expect(w.find('[data-test="fv-edit"]').exists()).toBe(false);
});

test("a stale-write error shows the reload banner and keeps edit mode", async () => {
  readFileMock.mockResolvedValue({ workspace: "ws", path: "a.ts", content: "old", size: 3, mtimeMs: 100, truncated: false, binary: false });
  filesStore.saveFile = vi.fn().mockRejectedValue(new Error("stale-write"));
  const w = mountViewer({ path: "a.ts" });
  await flush();
  await w.get('[data-test="fv-edit"]').trigger("click");
  await w.get('[data-test="fv-save"]').trigger("click");
  await flush();
  expect(w.find('[data-test="fv-save-error"]').exists()).toBe(true);
  expect(w.find('[data-test="code-editor"]').exists()).toBe(true); // still editing, draft kept
});
```

> Match the existing test harness names in `fileviewer.test.ts` (`mountViewer`, `flush`, `readFileMock`, `filesStore`). If they differ, adapt these three tests to the file's existing helpers rather than inventing new ones.

- [ ] **Step 2: Run to verify failure.**

Run: `cd packages/relay-web && npx vitest run src/__tests__/fileviewer.test.ts`
Expected: FAIL — no `fv-edit` button.

- [ ] **Step 3: Add edit state + logic to `FileViewer.vue`.** In the `<script setup>`:

Add imports (extend the lucide import and add CodeEditor + i18n):

```ts
import { Pencil, Save as SaveIcon } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import CodeEditor from "./CodeEditor.vue";
```

Add `dirty-change` to `defineEmits`:

```ts
const emit = defineEmits<{ back: []; close: []; "dirty-change": [boolean] }>();
const { t } = useI18n();
```

After the existing `canFind` computed, add the edit state:

```ts
// ── Edit mode ────────────────────────────────────────────────────────────────────────
const editing = ref(false);
const draft = ref("");
const baseRev = ref<{ mtimeMs: number; size: number } | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

const canEdit = computed(
  () => !!file.value && !file.value.binary && !file.value.truncated && fileLines.value.length <= LINE_GUTTER_LIMIT,
);
const editDirty = computed(() => editing.value && !!file.value && draft.value !== file.value.content);
watch(editDirty, (v) => emit("dirty-change", v));

// Map backend error codes to friendly copy; unknown codes pass through raw.
const saveErrorLabel = computed(() => {
  const code = saveError.value;
  if (!code) return "";
  const known: Record<string, string> = {
    "stale-write": t("files.staleConflict"),
    "files-write-disabled": t("files.writeDisabled"),
    "is-binary": t("files.binaryNotEditable"),
    "file-too-large": t("files.tooLarge"),
  };
  return known[code] ?? code;
});
const isStale = computed(() => saveError.value === "stale-write");

function startEdit() {
  if (!canEdit.value || !file.value) return;
  draft.value = file.value.content;
  baseRev.value = { mtimeMs: file.value.mtimeMs, size: file.value.size };
  saveError.value = null;
  editing.value = true;
  closeFind();
}
function cancelEdit() {
  editing.value = false;
  draft.value = "";
  saveError.value = null;
  emit("dirty-change", false);
}
async function save() {
  if (!file.value || !baseRev.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const res = await files.saveFile(props.instanceId, props.workspace, file.value.path, draft.value, baseRev.value);
    file.value = { ...file.value, content: draft.value, size: res.size, mtimeMs: res.mtimeMs };
    editing.value = false;
    emit("dirty-change", false);
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : "write-failed";
  } finally {
    saving.value = false;
  }
}
async function reloadFromDisk() {
  await load();          // re-reads → fresh mtime/size; draft is preserved for copy
  if (file.value) baseRev.value = { mtimeMs: file.value.mtimeMs, size: file.value.size };
  saveError.value = null;
}
```

Extend `onKeydown` to save on Cmd/Ctrl-S while editing (add at the top of the function body, before the find handling):

```ts
  if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
    if (!rootEl.value || rootEl.value.offsetParent === null || !editing.value) return;
    e.preventDefault();
    void save();
    return;
  }
```

- [ ] **Step 4: Add the edit UI to `FileViewer.vue` template.**

In the header action group (the `<div class="ml-auto …">` block), add before the `CopyButton`:

```html
        <button v-if="canEdit && !editing" data-test="fv-edit" :aria-label="$t('files.editFile')" :title="$t('files.editFile')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                @click="startEdit()"><Pencil :size="15" /></button>
        <template v-if="editing">
          <span v-if="editDirty" data-test="fv-dirty-dot" class="mr-0.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          <button data-test="fv-save" :disabled="saving || !editDirty" :aria-label="$t('files.save')"
                  class="flex h-7 items-center gap-1 rounded px-2 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                  @click="save()"><SaveIcon :size="14" />{{ saving ? $t("files.saving") : $t("files.save") }}</button>
          <button data-test="fv-cancel" :aria-label="$t('files.cancel')"
                  class="h-7 rounded px-2 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                  @click="cancelEdit()">{{ $t("files.cancel") }}</button>
        </template>
```

In the body, add a save-error banner (above the file content `<template v-if="file">`), and swap the read view for the editor while editing:

```html
      <!-- save error / stale-conflict banner -->
      <div v-if="saveError" data-test="fv-save-error" class="m-3 flex items-center gap-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
        <span class="min-w-0 flex-1">{{ saveErrorLabel }}</span>
        <button v-if="isStale" data-test="fv-reload" class="shrink-0 rounded bg-danger/15 px-2 py-0.5 text-[12px] font-medium hover:bg-danger/25" @click="reloadFromDisk()">{{ $t("files.reload") }}</button>
      </div>
      <!-- editor takes over the body while editing -->
      <CodeEditor v-if="editing && file" data-test="fv-editor" v-model="draft" :filename="file.path" class="h-full" @save="save()" />
```

Wrap the existing `<template v-if="file">` file-body block so it only renders when NOT editing — change its opening to `<template v-else-if="file">` (so `editing` wins) — and leave the diff branch as the following `v-else-if`.

> Concretely: the body's first child becomes the `saveError` banner, then the `CodeEditor` (`v-if="editing && file"`), then the file view (`v-else-if="file"`), then the diff view (`v-else-if="props.diffPath && diff"`). Keep the `error`/`loading` blocks at the very top as they are.

- [ ] **Step 5: Add i18n keys.** In `packages/relay-web/src/i18n/messages/en.ts`, inside the `files: { … }` object, add:

```ts
    editFile: "Edit",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    reload: "Reload",
    unsavedConfirm: "Discard unsaved changes?",
    staleConflict: "This file changed on disk. Reload to get the latest, then re-apply your edits.",
    writeDisabled: "Editing is disabled on this instance.",
    binaryNotEditable: "Binary files can't be edited.",
    tooLarge: "File is too large to save.",
```

In `packages/relay-web/src/i18n/messages/zh-CN.ts`, inside `files: { … }`, add:

```ts
    editFile: "编辑",
    save: "保存",
    saving: "保存中…",
    cancel: "取消",
    reload: "重新加载",
    unsavedConfirm: "放弃未保存的修改？",
    staleConflict: "该文件已在磁盘上变化。请重新加载获取最新内容，再重新应用你的修改。",
    writeDisabled: "该实例已禁用编辑。",
    binaryNotEditable: "二进制文件不可编辑。",
    tooLarge: "文件过大，无法保存。",
```

- [ ] **Step 6: Wire `dirty-change` + guarded close in `DashboardView.vue`.** On the `<FileViewer … />` (line ~383), add `@dirty-change`:

```html
                        @dirty-change="(v) => centerTabs.setDirty(key, tab.id, v)"
```

Change its `@close` to route through the guard (add a helper near the other center-tab handlers in `<script setup>`):

```ts
import { useI18n } from "vue-i18n"; // if not already imported
const { t: tt } = useI18n();        // if `t` isn't already available in this scope
function requestCloseTab(key: string, id: string) {
  centerTabs.closeTabGuarded(key, id, () => window.confirm(tt("files.unsavedConfirm")));
}
```

Then set the FileViewer/TerminalTab `@close` to `@close="requestCloseTab(key, tab.id)"`.

> If `DashboardView.vue` already destructures `t` from `useI18n()`, reuse it instead of adding `tt`.

- [ ] **Step 7: Dirty dot + guarded close in `CenterTabStrip.vue`.** The close button (line ~136) currently calls `store.closeTab`. Change it to guard:

```html
        @click.stop="store.closeTabGuarded(props.sessionKey, tab.id, () => window.confirm($t('files.unsavedConfirm')))"
```

And add a dirty dot next to the tab label (inside the tab button, before the close button):

```html
        <span v-if="tab.kind === 'file' && tab.dirty" class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
```

- [ ] **Step 8: Run the FileViewer tests to verify they pass.**

Run: `cd packages/relay-web && npx vitest run src/__tests__/fileviewer.test.ts src/__tests__/files-i18n.test.ts src/__tests__/i18n-parity.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck.**

Run: `cd packages/relay-web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit.**

```bash
git add packages/relay-web/src/components/FileViewer.vue packages/relay-web/src/views/DashboardView.vue packages/relay-web/src/components/CenterTabStrip.vue packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/__tests__/fileviewer.test.ts
git commit -m "feat(relay-web): file viewer edit mode with CodeMirror, save, stale guard"
```

---

### Task 8: Integration — full build, typecheck, and test sweep

**Files:** none (verification only)

- [ ] **Step 1: Full relay-web unit suite.**

Run: `cd packages/relay-web && npx vitest run`
Expected: all pass (in particular `fileviewer`, `codeeditor`, `center-tabs`, `files`, `i18n-parity`).

- [ ] **Step 2: Backend unit sweep for the touched files.**

Run (from repo root): `bun test tests/unit/control/workspace-fs-writes.test.ts tests/unit/control/control-service-files-gate.test.ts`
Expected: all pass.

- [ ] **Step 3: Full package build (includes bundling relay-web into the hub + protocol assert).**

Run: `bun run build:packages`
Expected: completes; ends without the `FATAL` guards firing (`bundled relay-web dashboard -> …` prints).

- [ ] **Step 4: Publish verification.**

Run: `bun run verify:publish`
Expected: `Publish verification passed.`

- [ ] **Step 5: Ops note (no code) — connector reinstall for live testing.**

The connector (`@ganglion/xacpx-channel-relay`) is loaded from the plugin home as a packed tarball, not the project `dist/`. To exercise `control.fs.write` end-to-end on a running console, the connector must be **repacked, reinstalled into the plugin home, and the console restarted** — editing `packages/channel-relay/dist` alone does not take effect. Record this in the release checklist; it is the known "sandbox connector from plugin home" trap.

- [ ] **Step 6: Final commit (if any lockfile/build artifacts changed).**

```bash
git add -- package-lock.json packages/relay-web/bun.lock
git commit -m "chore: sync locks for file edit & save" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec §1 safety invariants** → Task 2 (server: not-a-file/is-binary/file-too-large/stale-write), Task 7 (`canEdit` gates binary/truncated/oversized in UI), Task 3 (gate). ✓
- **Spec §2 RPC across 4 layers** → Task 1 (protocol), Task 2/3 (core + connector), Task 4 (web store). ✓
- **Spec §2.4 mtime+size token** → Task 1 (types), Task 2 (compare), Task 7 (capture at `startEdit`). ✓
- **Spec §3 CodeMirror editor** → Task 5. ✓
- **Spec §4 unsaved-changes intercept** → Task 6 (store) + Task 7 (dirty-change wiring, guarded close, dirty dot). Draft persists because each file tab's FileViewer stays mounted (`v-show`), so only *close* is destructive and thus guarded — switching tabs needs no prompt. ✓
- **Spec §5 error handling** → Task 7 (`saveErrorLabel`, stale reload banner, disabled edit entry). ✓
- **Spec §6 testing** → Tasks 2,3,4,5,6,7 each ship tests; Task 8 sweeps. ✓
- **Spec §7 i18n** → Task 7 Step 5 (en + zh-CN, parity test in Step 8). ✓
- **Spec §8 release** → Task 8 Step 5 ops note; actual version bumps/tags are the separate deferred release effort, out of this plan's scope. ✓
