# relay-web Message Attachments (Images + Files) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the relay-web dashboard attach images or arbitrary files to a chat message, delivered through relay hub → connector → core into the acpx session, with attachments persisted for history re-display.

**Architecture:** Two-phase upload (mirrors the existing `control.fs.*` workspace-fs RPC pattern). Phase 1: a new non-chat-scoped `control.upload` RPC carries base64 bytes hub→connector→core, where `ControlService.uploadFile` sanitizes + writes them to a daemon-side temp dir and returns the absolute path. Phase 2: `control.prompt` carries lightweight attachment refs (path + metadata), which `ControlService` maps to `ChannelMediaAttachment[]` and feeds to the already-wired `agent.chat → router → transport.prompt({media}) → prompt-media → ACP image/resource block` chain. The hub persists attachment metadata (incl. a downscaled image preview) so history re-displays after reload.

**Tech Stack:** TypeScript, Bun (build/test), Vue 3 + Pinia + Vitest (relay-web), Hono + node:sqlite/bun:sqlite (relay hub), node:fs (core).

## Global Constraints

- **Per-file size cap:** 10 MB (enforced at hub AND core — defense in depth).
- **Per-message attachment count:** ≤ 5.
- **Persisted preview:** images only; client downscales to ≤ 512px before producing `previewUrl` (data URL). Non-images get no preview.
- **Temp upload dir:** `~/.xacpx/runtime/uploads/<rand>/<safe-name>`; cleaned on daemon startup + TTL 24h. History re-display relies on the persisted `previewUrl`, never on temp-file survival.
- **Filename safety:** sanitize to basename, strip `..` and path separators, reject path escape.
- **`control.upload` is NOT chat-scoped** — it must NOT be added to `CHAT_SCOPED_TYPES` (no `chatKey`/`senderId` injection), matching `control.fs.*`.
- **relay-protocol builds with tsc + bun then asserts** — after changing it run `bun run build:relay-protocol` and confirm `assert:relay-protocol` passes (guards the "empty barrel" tree-shake bug).
- **Core media path is already wired** — do NOT modify `src/transport/**`, `src/console-agent.ts`, `src/commands/**`, or `prompt-media.ts`. The only core change is in `src/control/`.
- **Tests:** relay-web `bun run --cwd packages/relay-web test`; core/connector `npm test` (typecheck + unit). Verify relay-web tests file-by-file, never whole-dir `bun test`.

---

### Task 1: relay-protocol types (upload RPC, attachment refs, persisted metadata)

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts` (MSG constant ~6-39; PromptPayload ~176-182; add upload payload/result + PromptAttachmentRef)
- Modify: `packages/relay-protocol/src/web-dtos.ts` (MessageRecordDto ~11-25; add AttachmentMetadata)

**Interfaces:**
- Produces:
  - `MSG.upload = "control.upload"`
  - `interface UploadPayload { filename: string; content: string; mimeType: string }`
  - `interface UploadResult { id: string; path: string; filename: string; mimeType: string; size: number }`
  - `interface PromptAttachmentRef { id: string; filePath: string; fileName: string; mimeType: string; kind: "image" | "file"; size: number; previewUrl?: string }`
  - `PromptPayload.media?: PromptAttachmentRef[]`
  - `interface AttachmentMetadata { id: string; filename: string; mimeType: string; size: number; kind: "image" | "file"; previewUrl?: string }`
  - `MessageRecordDto.attachments?: AttachmentMetadata[]`

- [ ] **Step 1: Add `upload` to the MSG constant**

In `packages/relay-protocol/src/messages.ts`, add to the `MSG` object (next to the `fs*` entries):

```typescript
  fsSearch: "control.fs.search",
  upload: "control.upload",
  sessionModelGet: "control.session.model.get",
```

- [ ] **Step 2: Add upload + attachment-ref interfaces**

In `packages/relay-protocol/src/messages.ts`, near `PromptPayload`/`PromptResult` (~176-187), add:

```typescript
export interface PromptAttachmentRef {
  /** Stable id from the upload step; used as a message id for the channel media source. */
  id: string;
  /** Absolute path on the daemon host (returned by control.upload). */
  filePath: string;
  fileName: string;
  mimeType: string;
  kind: "image" | "file";
  size: number;
  /** Downscaled data URL for images; carried so the hub can persist a preview. Omitted for files. */
  previewUrl?: string;
}

export interface UploadPayload {
  filename: string;
  /** base64-encoded file bytes (no data-URL prefix). */
  content: string;
  mimeType: string;
}

export interface UploadResult {
  id: string;
  /** Absolute path on the daemon host where the bytes were written. */
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}
```

- [ ] **Step 3: Add `media` to PromptPayload**

In `packages/relay-protocol/src/messages.ts`, extend `PromptPayload` (~176-182):

```typescript
export interface PromptPayload {
  chatKey: string;
  sessionAlias: string;
  text: string;
  senderId: string;
  isOwner?: boolean;
  media?: PromptAttachmentRef[];
}
```

- [ ] **Step 4: Add AttachmentMetadata + extend MessageRecordDto**

In `packages/relay-protocol/src/web-dtos.ts`, add the interface and extend `MessageRecordDto` (~11-25):

```typescript
export interface AttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  /** Downscaled data URL for images; omitted for files. */
  previewUrl?: string;
}

export interface MessageRecordDto {
  id?: number;
  instanceId: string;
  sessionAlias: string;
  direction: MessageDirection;
  text: string;
  createdAt: string;
  structured?: { toolSteps?: ToolStepDto[]; reasoning?: string; parts?: TurnPartDto[]; scheduled?: ScheduledOriginDto };
  attachments?: AttachmentMetadata[];
}
```

- [ ] **Step 5: Build relay-protocol and verify the barrel assert passes**

Run: `bun run build:relay-protocol`
Expected: completes, ending with the `assert:relay-protocol` step printing no FATAL and exit 0.

- [ ] **Step 6: Typecheck the whole repo**

Run: `npx tsc --noEmit`
Expected: PASS (new exports compile; no consumers broken yet).

- [ ] **Step 7: Commit**

```bash
git add packages/relay-protocol/src/messages.ts packages/relay-protocol/src/web-dtos.ts packages/relay-protocol/dist
git commit -m "feat(relay-protocol): add control.upload + attachment ref/metadata types"
```

---

### Task 2: core UploadStore (write bytes to temp dir, sanitize, size cap, TTL cleanup)

**Files:**
- Create: `src/control/upload-store.ts`
- Create: `tests/unit/control/upload-store.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks (self-contained core module).
- Produces:
  - `class UploadStore { constructor(opts?: { rootDir?: string; maxBytes?: number; ttlMs?: number; now?: () => Date }); save(filename: string, base64: string, mimeType: string): Promise<{ id: string; path: string; filename: string; mimeType: string; size: number }>; cleanup(): Promise<number>; }`
  - Default `rootDir` resolves to `<coreHome>/runtime/uploads`; default `maxBytes` 10 MiB; default `ttlMs` 24h.
  - `save` throws `Error("file-too-large")` over the cap and `Error("empty-file")` on zero bytes.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/control/upload-store.test.ts`:

```typescript
import { mkdtemp, readFile, stat, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { UploadStore } from "../../../src/control/upload-store";

async function freshRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "upload-store-test-"));
}

describe("UploadStore", () => {
  it("writes base64 bytes to a sandboxed file and returns an absolute path + size", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root });
    const bytes = Buffer.from("hello world");
    const res = await store.save("note.txt", bytes.toString("base64"), "text/plain");

    expect(res.path.startsWith(root)).toBe(true);
    expect(res.filename).toBe("note.txt");
    expect(res.size).toBe(bytes.byteLength);
    expect(res.id).toMatch(/.+/);
    expect((await readFile(res.path)).equals(bytes)).toBe(true);
  });

  it("sanitizes path-traversal filenames to a basename", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root });
    const res = await store.save("../../etc/passwd", Buffer.from("x").toString("base64"), "text/plain");

    expect(res.filename).toBe("passwd");
    expect(res.path.startsWith(root)).toBe(true);
    expect(res.path.includes("..")).toBe(false);
  });

  it("rejects files over the byte cap", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root, maxBytes: 8 });
    await expect(store.save("big.bin", Buffer.alloc(9).toString("base64"), "application/octet-stream")).rejects.toThrow(
      "file-too-large",
    );
  });

  it("rejects empty content", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root });
    await expect(store.save("empty.txt", "", "text/plain")).rejects.toThrow("empty-file");
  });

  it("cleanup() removes upload dirs older than the TTL and keeps fresh ones", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root, ttlMs: 1000 });
    const stale = await store.save("old.txt", Buffer.from("old").toString("base64"), "text/plain");
    const fresh = await store.save("new.txt", Buffer.from("new").toString("base64"), "text/plain");

    // Backdate the stale entry's directory mtime well beyond the TTL.
    const staleDir = join(stale.path, "..");
    const past = new Date(Date.now() - 60_000);
    await utimes(staleDir, past, past);

    const removed = await store.cleanup();
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(stat(stale.path)).rejects.toThrow();
    expect((await stat(fresh.path)).isFile()).toBe(true);
    expect((await readdir(root)).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd . vitest run tests/unit/control/upload-store.test.ts` (or `npx vitest run tests/unit/control/upload-store.test.ts`)
Expected: FAIL with "Cannot find module '../../../src/control/upload-store'".

- [ ] **Step 3: Implement UploadStore**

Create `src/control/upload-store.ts`:

```typescript
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { coreHomeDir } from "../runtime/core-home.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface UploadStoreOptions {
  rootDir?: string;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => Date;
}

export interface SavedUpload {
  id: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

function defaultRootDir(): string {
  const home = process.env.HOME ?? homedir();
  return path.join(coreHomeDir(home), "runtime", "uploads");
}

/** Strip directory components and traversal segments, leaving a safe basename. */
export function sanitizeUploadFilename(raw: string): string {
  const base = path.basename(raw).replace(/[/\\]/g, "").replace(/^\.+/, "");
  const cleaned = base.trim();
  return cleaned.length > 0 ? cleaned : "file";
}

export class UploadStore {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(opts: UploadStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultRootDir();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  async save(filename: string, base64: string, mimeType: string): Promise<SavedUpload> {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength === 0) throw new Error("empty-file");
    if (bytes.byteLength > this.maxBytes) throw new Error("file-too-large");

    const safeName = sanitizeUploadFilename(filename);
    await mkdtemp(this.rootDir + path.sep).catch(() => undefined); // ensure parent exists below
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.rootDir, { recursive: true });
    const dir = await mkdtemp(path.join(this.rootDir, "u-"));
    const filePath = path.join(dir, safeName);
    await writeFile(filePath, bytes);

    return {
      id: path.basename(dir),
      path: filePath,
      filename: safeName,
      mimeType,
      size: bytes.byteLength,
    };
  }

  /** Remove upload dirs whose mtime is older than the TTL. Returns count removed. */
  async cleanup(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return 0;
    }
    const cutoff = this.now().getTime() - this.ttlMs;
    let removed = 0;
    for (const name of entries) {
      const dir = path.join(this.rootDir, name);
      try {
        const info = await stat(dir);
        if (info.mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // ignore races
      }
    }
    return removed;
  }
}
```

> Note: the `mkdtemp(this.rootDir + sep)` line is a no-op safety attempt; the authoritative directory creation is the `mkdir(this.rootDir, { recursive: true })` immediately after. Keep both — the catch swallows the case where the root does not yet exist.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/control/upload-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Simplify the directory-creation (remove the dead mkdtemp probe)**

Replace the two-line probe with a single clear `mkdir`. In `src/control/upload-store.ts` `save()`:

```typescript
    const safeName = sanitizeUploadFilename(filename);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.rootDir, { recursive: true });
    const dir = await mkdtemp(path.join(this.rootDir, "u-"));
```

- [ ] **Step 6: Re-run the test**

Run: `npx vitest run tests/unit/control/upload-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/control/upload-store.ts tests/unit/control/upload-store.test.ts
git commit -m "feat(control): UploadStore — sandboxed temp writes, size cap, TTL cleanup"
```

---

### Task 3: core ControlService — `uploadFile` + media passthrough into `agent.chat`

**Files:**
- Modify: `src/control/control-service.ts` (ControlPromptInput ~103-110; constructor/fields ~142-149; add `uploadFile`; `prompt()`/`executeTurn` ~364-512)
- Create: `tests/unit/control/control-service-media.test.ts`

**Interfaces:**
- Consumes: `UploadStore` from Task 2 (`save`, `cleanup`); `PromptAttachmentRef`, `UploadPayload`, `UploadResult` from Task 1.
- Produces:
  - `ControlService.uploadFile(input: UploadPayload): Promise<UploadResult>`
  - `ControlPromptInput.media?: PromptAttachmentRef[]`
  - `executeTurn` builds `ChannelMediaAttachment[]` and passes it as `agent.chat({ media })`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/control/control-service-media.test.ts`. This test uses a fake `agent` to capture what `chat()` receives, plus a real `UploadStore` pointed at a temp dir.

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ControlService } from "../../../src/control/control-service";
import { UploadStore } from "../../../src/control/upload-store";

// Minimal deps stub — only what prompt()/uploadFile touch in this test.
function buildService(chatSpy: ReturnType<typeof vi.fn>, uploadStore: UploadStore) {
  const deps = {
    agent: { chat: chatSpy },
    sessions: { resolve: vi.fn(async () => ({ alias: "main", agent: "claude", workspace: "ws", transportSession: "t", cwd: "/tmp" })) },
    events: { emit: vi.fn() },
    workspaces: { list: () => [] },
    uploadStore,
    // ...any other deps your ControlService requires can be added as vi.fn() stubs
  } as unknown as ConstructorParameters<typeof ControlService>[0];
  return new ControlService(deps);
}

describe("ControlService media", () => {
  it("uploadFile writes bytes and returns an absolute daemon path", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-upload-"));
    const store = new UploadStore({ rootDir: root });
    const svc = buildService(vi.fn(), store);

    const res = await svc.uploadFile({ filename: "shot.png", content: Buffer.from("PNG").toString("base64"), mimeType: "image/png" });
    expect(res.path.startsWith(root)).toBe(true);
    expect(res.filename).toBe("shot.png");
    expect(res.size).toBe(3);
  });

  it("prompt() forwards media refs to agent.chat as ChannelMediaAttachment[]", async () => {
    const chat = vi.fn(async () => ({ text: "ok" }));
    const root = await mkdtemp(join(tmpdir(), "cs-upload-"));
    const svc = buildService(chat, new UploadStore({ rootDir: root }));

    await svc.prompt({
      chatKey: "relay:a1",
      sessionAlias: "main",
      text: "look at this",
      senderId: "a1",
      isOwner: true,
      media: [{ id: "u-1", filePath: "/tmp/u-1/shot.png", fileName: "shot.png", mimeType: "image/png", kind: "image", size: 3 }],
    });

    expect(chat).toHaveBeenCalledTimes(1);
    const arg = chat.mock.calls[0][0];
    expect(Array.isArray(arg.media)).toBe(true);
    expect(arg.media[0]).toMatchObject({
      kind: "image",
      filePath: "/tmp/u-1/shot.png",
      mimeType: "image/png",
      fileName: "shot.png",
    });
    expect(arg.media[0].source.channelId).toBe("relay");
  });
});
```

> If `ControlService`'s constructor requires additional non-optional deps, add them as `vi.fn()` stubs in `buildService` — do not change production types to satisfy the test. Inspect `ControlServiceDeps` (`src/control/control-service.ts` ~54-101) and stub each field minimally.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/control/control-service-media.test.ts`
Expected: FAIL — `uploadFile` is not a function / `media` not forwarded.

- [ ] **Step 3: Add `uploadStore` to ControlServiceDeps and the `uploadFile` method**

In `src/control/control-service.ts`:

3a. Add to the `ControlServiceDeps` interface (~54-101):

```typescript
  uploadStore: import("./upload-store.js").UploadStore;
```

3b. Add the import at the top of the file:

```typescript
import type { UploadStore } from "./upload-store.js";
```

(and change the deps field to `uploadStore: UploadStore;`)

3c. Add the method next to the fs methods (~151-165):

```typescript
  async uploadFile(input: { filename: string; content: string; mimeType: string }): Promise<{ id: string; path: string; filename: string; mimeType: string; size: number }> {
    return this.deps.uploadStore.save(input.filename, input.content, input.mimeType);
  }
```

- [ ] **Step 4: Add `media` to ControlPromptInput and thread it through `prompt()` → `executeTurn`**

4a. Extend `ControlPromptInput` (~103-110):

```typescript
export interface ControlPromptInput {
  chatKey: string;
  sessionAlias: string;
  text: string;
  accountId?: string;
  senderId: string;
  isOwner?: boolean;
  media?: import("@ganglion/xacpx-relay-protocol").PromptAttachmentRef[];
}
```

> If the file already imports from `@ganglion/xacpx-relay-protocol`, add `PromptAttachmentRef` to that import and use the bare name instead of the inline `import(...)`.

4b. In `prompt()` (~364-372), forward media into the `executeTurn` params:

```typescript
  async prompt(input: ControlPromptInput): Promise<ControlPromptResult> {
    return this.executeTurn({
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      text: input.text,
      senderId: input.senderId,
      ...(input.isOwner !== undefined ? { isOwner: input.isOwner } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.media !== undefined ? { media: input.media } : {}),
    });
  }
```

4c. Add `media?` to the `executeTurn` params type (find the `private async executeTurn(params: {...})` signature) by adding:

```typescript
    media?: import("@ganglion/xacpx-relay-protocol").PromptAttachmentRef[];
```

4d. In `executeTurn`, where it calls `this.deps.agent.chat({...})` (~470-512), build and pass the media array. Add this just before the `agent.chat` call:

```typescript
    const chatMedia = (params.media ?? []).map((ref) => ({
      kind: ref.kind,
      filePath: ref.filePath,
      mimeType: ref.mimeType,
      ...(ref.fileName ? { fileName: ref.fileName } : {}),
      sizeBytes: ref.size,
      source: {
        channelId: "relay",
        accountId: params.accountId ?? "control",
        chatKey: params.chatKey,
        messageId: ref.id,
      },
    }));
```

and add to the `agent.chat({...})` object literal:

```typescript
      ...(chatMedia.length > 0 ? { media: chatMedia } : {}),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/control/control-service-media.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire UploadStore into the runtime + startup cleanup**

Find where `ControlService` is constructed (grep `new ControlService(`) — likely in `src/main.ts` (`buildApp`) or a control wiring module. Add an `UploadStore` instance to its deps:

```typescript
import { UploadStore } from "./control/upload-store.js";
// ...
const uploadStore = new UploadStore();
void uploadStore.cleanup(); // best-effort startup sweep
// ...pass `uploadStore` into the ControlService deps object.
```

> Place the `void uploadStore.cleanup()` call in the same startup path as other best-effort reaps. A periodic sweep is optional; the startup sweep + 24h-stale check on each startup is the minimum. Do NOT block startup on it.

- [ ] **Step 7: Typecheck + run the full core unit suite**

Run: `npx tsc --noEmit && npm run test:unit`
Expected: PASS (typecheck clean; existing suites green; new tests included).

- [ ] **Step 8: Commit**

```bash
git add src/control/control-service.ts src/main.ts tests/unit/control/control-service-media.test.ts
git commit -m "feat(control): uploadFile RPC method + forward prompt media into agent.chat"
```

---

### Task 4: connector control-bridge — `control.upload` case

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts` (dispatch switch ~79-217)
- Modify (test): add or extend the connector's control-bridge test if one exists (grep `dispatchControlRequest` under `packages/channel-relay/**/__tests__` or `tests`)

**Interfaces:**
- Consumes: `MSG.upload`, `UploadPayload` from Task 1; `ControlService.uploadFile` from Task 3.
- Produces: dispatch of `control.upload` → `control.uploadFile(payload)`.

- [ ] **Step 1: Add the dispatch case**

In `packages/channel-relay/src/control-bridge.ts`, in `dispatchControlRequest`, next to the `fs*` cases, add:

```typescript
    case MSG.upload: {
      const input = payload as UploadPayload;
      if (!input.filename || !input.content || !input.mimeType) {
        return errorPayload("bad-request", "filename, content and mimeType are required");
      }
      return await control.uploadFile(input);
    }
```

- [ ] **Step 2: Add the `UploadPayload` import**

Add `UploadPayload` to the existing `@ganglion/xacpx-relay-protocol` import in that file (alongside `FsListPayload` etc.).

- [ ] **Step 3: Typecheck the connector package**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: (If a control-bridge test exists) add a dispatch test**

If `packages/channel-relay` has a test that calls `dispatchControlRequest` with a fake `ControlService`, add a case asserting `MSG.upload` calls `control.uploadFile` and bad input returns an `errorPayload`. Mirror the existing `fsList` test exactly. If no such test exists, skip this step (coverage lives in Task 3 + Task 8 e2e).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-relay/src/control-bridge.ts
git commit -m "feat(connector): dispatch control.upload to ControlService.uploadFile"
```

---

### Task 5: relay hub — persist attachment metadata + size re-validation

**Files:**
- Modify: `packages/relay/src/db.ts` (messages table ~110-119; add `attachments` column + idempotent guard)
- Modify: `packages/relay/src/stores/messages.ts` (`append` ~26-31; `listBySession` map ~60-69)
- Modify: `packages/relay/src/http/app.ts` (RPC endpoint persist ~277-280; optional upload size guard ~262)
- Modify (test): `packages/relay/**` message store test (grep `MessageStore` under relay tests)

**Interfaces:**
- Consumes: `AttachmentMetadata`, `PromptAttachmentRef`, `MSG.upload` from Task 1.
- Produces:
  - `MessageStore.append(instanceId, sessionAlias, direction, text, structured?, attachments?)`
  - `listBySession` returns `attachments` on rows that have them.
  - Hub maps inbound `PromptPayload.media` → `AttachmentMetadata[]` when persisting the user message.

- [ ] **Step 1: Add the `attachments` column (create + idempotent ALTER)**

In `packages/relay/src/db.ts`, add `attachments TEXT` to the `messages` CREATE TABLE (~110-118):

```typescript
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL REFERENCES instances(id),
      session_alias TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      structured TEXT,
      attachments TEXT
    );
```

Then, at the END of `initSchema` (after the CREATE blocks), add an idempotent guard for the already-existing local dev DB:

```typescript
  // Idempotent column add for pre-existing local dev DBs (create-only schema otherwise).
  const messageCols = db.all<{ name: string }>("PRAGMA table_info(messages)");
  if (!messageCols.some((c) => c.name === "attachments")) {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  }
```

> If `SqlDriver` exposes `all` differently, match the existing call style used elsewhere in `db.ts`/stores. The PRAGMA returns one row per column.

- [ ] **Step 2: Write the failing store test**

In the existing relay message-store test file (or create `packages/relay/src/stores/messages.test.ts`), add:

```typescript
it("persists and returns attachment metadata on inbound messages", () => {
  // `db` and `store` setup mirrors the existing tests in this file.
  const atts = [{ id: "u-1", filename: "shot.png", mimeType: "image/png", size: 3, kind: "image" as const, previewUrl: "data:image/png;base64,AAAA" }];
  store.append("i1", "main", "in", "look", undefined, atts);
  const page = store.listBySession("acc1", "i1", "main");
  expect(page.messages.at(-1)?.attachments).toEqual(atts);
});
```

> Reuse this file's existing `beforeEach` DB/account/instance fixture. If the fixture inserts an account+instance, do the same so the JOIN in `listBySession` matches.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run --cwd packages/relay test -- messages` (match the package's test runner; if it uses `vitest run`, filter by file)
Expected: FAIL — `append` ignores the 6th arg / `attachments` undefined on result.

- [ ] **Step 4: Extend `append` and `listBySession`**

In `packages/relay/src/stores/messages.ts`:

4a. Add the import + row field:

```typescript
import type { AttachmentMetadata, MessageDirection, MessageRecordDto } from "@ganglion/xacpx-relay-protocol";
```

Add `attachments: string | null;` to `interface MessageRow`.

4b. Replace `append`:

```typescript
  append(
    instanceId: string,
    sessionAlias: string,
    direction: MessageDirection,
    text: string,
    structured?: StructuredTurn,
    attachments?: AttachmentMetadata[],
  ): void {
    this.db.run(
      "INSERT INTO messages (instance_id, session_alias, direction, text, created_at, structured, attachments) VALUES (?,?,?,?,?,?,?)",
      [
        instanceId,
        sessionAlias,
        direction,
        text,
        this.now().toISOString(),
        structured ? JSON.stringify(structured) : null,
        attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
      ],
    );
  }
```

4c. Add `m.attachments` to the SELECT column list in `listBySession`:

```typescript
      `SELECT m.id, m.instance_id, m.session_alias, m.direction, m.text, m.created_at, m.structured, m.attachments
       FROM messages m JOIN instances i ON i.id = m.instance_id
```

4d. Add to the row map:

```typescript
        ...(r.structured ? { structured: JSON.parse(r.structured) as StructuredTurn } : {}),
        ...(r.attachments ? { attachments: JSON.parse(r.attachments) as AttachmentMetadata[] } : {}),
```

- [ ] **Step 5: Run the store test to verify it passes**

Run: `bun run --cwd packages/relay test -- messages`
Expected: PASS.

- [ ] **Step 6: Persist attachments from the prompt payload + re-validate size in the hub**

In `packages/relay/src/http/app.ts`, in the RPC endpoint (~277-280), change the inbound persist for `MSG.prompt` to also map+store attachments:

```typescript
      if (body.type === MSG.prompt || body.type === MSG.commandExecute) {
        const p = payload as { sessionAlias?: string; text?: string; media?: import("@ganglion/xacpx-relay-protocol").PromptAttachmentRef[] };
        if (p.sessionAlias && p.text !== undefined) {
          const attachments = (p.media ?? []).map((m) => ({
            id: m.id,
            filename: m.fileName,
            mimeType: m.mimeType,
            size: m.size,
            kind: m.kind,
            ...(m.previewUrl ? { previewUrl: m.previewUrl } : {}),
          }));
          deps.messages.append(instance.id, p.sessionAlias, "in", p.text, undefined, attachments);
        }
      }
```

> Note `p.text !== undefined` replaces the old `p.text` truthy check so a media-only message (empty text) still persists. Confirm core treats empty-text+media as valid (it does — `ConsoleAgent.chat` returns early only when BOTH text and media are empty).

Then add a server-side base64 size guard for `control.upload` (defense in depth, before forwarding) near the top of the try block:

```typescript
      if (body.type === MSG.upload) {
        const up = payload as { content?: string };
        const approxBytes = up.content ? Math.floor((up.content.length * 3) / 4) : 0;
        if (approxBytes > 10 * 1024 * 1024) return c.json({ error: "file-too-large" }, 413);
      }
```

- [ ] **Step 7: Typecheck + run hub tests**

Run: `npx tsc --noEmit && bun run --cwd packages/relay test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/relay/src/db.ts packages/relay/src/stores/messages.ts packages/relay/src/http/app.ts
git commit -m "feat(relay): persist message attachments + upload size guard"
```

---

### Task 6: relay-web data layer — upload client, image downscale, composer attachment state, send wiring

**Files:**
- Modify: `packages/relay-web/src/api/client.ts` (add `upload`)
- Create: `packages/relay-web/src/lib/image-downscale.ts`
- Modify: `packages/relay-web/src/stores/composer.ts` (add attachment state)
- Modify: `packages/relay-web/src/stores/chat.ts` (`send` accepts attachments ~310-336)
- Create: `packages/relay-web/src/__tests__/attachments.test.ts`

**Interfaces:**
- Consumes: `MSG.upload`/`UploadResult`/`PromptAttachmentRef`/`AttachmentMetadata` from Task 1.
- Produces:
  - `api.upload(instanceId, { filename, content, mimeType }): Promise<UploadResult>`
  - `downscaleImage(file: File, maxPx?: number): Promise<string | undefined>` — returns a data URL or `undefined` for non-images.
  - composer store: `pending: Ref<PendingAttachment[]>`, `addFiles(files: File[]): Promise<void>`, `removeAttachment(id)`, `clearAttachments()`, `uploading: Ref<boolean>`. `PendingAttachment = { id; filename; mimeType; size; kind: "image" | "file"; previewUrl?: string; filePath?: string; status: "uploading" | "ready" | "error" }`.
  - `chat.send(text, attachments?: PromptAttachmentRef[])` and optimistic `ChatMessage.attachments`.

- [ ] **Step 1: Add the upload API call**

In `packages/relay-web/src/api/client.ts`, add to the `api` object (after `rpc`):

```typescript
  /** Upload a file to the instance daemon; returns its absolute on-host path. */
  upload: (instanceId: string, payload: { filename: string; content: string; mimeType: string }) =>
    request<{ result: import("@ganglion/xacpx-relay-protocol").UploadResult }>(
      "POST",
      `/api/instances/${instanceId}/rpc`,
      { type: "control.upload", payload },
    ).then((r) => r.result),
```

- [ ] **Step 2: Write the failing test (downscale + composer + send)**

Create `packages/relay-web/src/__tests__/attachments.test.ts`:

```typescript
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";

const rpc = vi.fn();
const upload = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    rpc: (...a: unknown[]) => rpc(...a),
    upload: (...a: unknown[]) => upload(...a),
  },
}));

import { useComposerStore } from "../stores/composer";
import { useChatStore } from "../stores/chat";

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
  upload.mockReset();
});

test("addFiles uploads each file and tracks ready state with daemon path", async () => {
  upload.mockResolvedValue({ id: "u-1", path: "/home/.xacpx/runtime/uploads/u-1/a.txt", filename: "a.txt", mimeType: "text/plain", size: 3 });
  const composer = useComposerStore();
  composer.bindInstance("i1");
  const file = new File([new Uint8Array([97, 98, 99])], "a.txt", { type: "text/plain" });
  await composer.addFiles([file]);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(composer.pending).toHaveLength(1);
  expect(composer.pending[0]).toMatchObject({ filename: "a.txt", kind: "file", status: "ready", filePath: "/home/.xacpx/runtime/uploads/u-1/a.txt" });
});

test("addFiles rejects beyond the 5-attachment cap", async () => {
  upload.mockResolvedValue({ id: "u", path: "/p", filename: "f", mimeType: "text/plain", size: 1 });
  const composer = useComposerStore();
  composer.bindInstance("i1");
  const mk = (n: string) => new File([new Uint8Array([1])], n, { type: "text/plain" });
  await composer.addFiles([mk("1"), mk("2"), mk("3"), mk("4"), mk("5")]);
  await composer.addFiles([mk("6")]);
  expect(composer.pending).toHaveLength(5);
});

test("chat.send forwards ready attachments as media refs and clears them", async () => {
  rpc.mockResolvedValue({ ok: true });
  const chat = useChatStore();
  chat.select("i1", "main");
  await chat.send("hi", [{ id: "u-1", filePath: "/p/a.png", fileName: "a.png", mimeType: "image/png", kind: "image", size: 3, previewUrl: "data:image/png;base64,AA" }]);
  const [, type, payload] = rpc.mock.calls[0];
  expect(type).toBe("control.prompt");
  expect((payload as { media?: unknown[] }).media).toHaveLength(1);
  expect(chat.messages.at(-1)).toMatchObject({ direction: "in", text: "hi" });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run --cwd packages/relay-web test -- attachments`
Expected: FAIL — `bindInstance`/`addFiles` undefined; `send` ignores attachments.

- [ ] **Step 4: Implement the image downscale util**

Create `packages/relay-web/src/lib/image-downscale.ts`:

```typescript
/** Returns a downscaled data URL (≤ maxPx on the long edge) for images, or undefined for non-images. */
export async function downscaleImage(file: File, maxPx = 512): Promise<string | undefined> {
  if (!file.type.startsWith("image/")) return undefined;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return undefined;
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.8);
}

/** Reads a File as base64 (no data-URL prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
```

- [ ] **Step 5: Implement composer attachment state**

Rewrite `packages/relay-web/src/stores/composer.ts` to keep the existing insert API and add attachments:

```typescript
import { defineStore } from "pinia";
import { ref } from "vue";

import { api } from "../api/client";
import { downscaleImage, fileToBase64 } from "../lib/image-downscale";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export interface PendingAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;
  filePath?: string;
  status: "uploading" | "ready" | "error";
}

export const useComposerStore = defineStore("composer", () => {
  const insertRequest = ref<{ key: string; text: string; seq: number } | null>(null);
  let seq = 0;
  function requestInsert(key: string, text: string): void {
    insertRequest.value = { key, text, seq: ++seq };
  }

  const pending = ref<PendingAttachment[]>([]);
  const uploading = ref(false);
  let instanceId = "";
  let localSeq = 0;
  function bindInstance(id: string): void {
    instanceId = id;
  }

  async function addFiles(files: File[]): Promise<void> {
    if (!instanceId) return;
    for (const file of files) {
      if (pending.value.length >= MAX_ATTACHMENTS) break;
      if (file.size > MAX_BYTES) continue;
      const localId = `local-${++localSeq}`;
      const kind: "image" | "file" = file.type.startsWith("image/") ? "image" : "file";
      const entry: PendingAttachment = { id: localId, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size, kind, status: "uploading" };
      pending.value.push(entry);
      uploading.value = true;
      try {
        const previewUrl = await downscaleImage(file);
        if (previewUrl) entry.previewUrl = previewUrl;
        const content = await fileToBase64(file);
        const res = await api.upload(instanceId, { filename: file.name, content, mimeType: entry.mimeType });
        entry.filePath = res.path;
        entry.id = res.id;
        entry.size = res.size;
        entry.status = "ready";
      } catch {
        entry.status = "error";
      }
    }
    uploading.value = pending.value.some((p) => p.status === "uploading");
  }

  function removeAttachment(id: string): void {
    pending.value = pending.value.filter((p) => p.id !== id);
  }
  function clearAttachments(): void {
    pending.value = [];
  }

  return { insertRequest, requestInsert, pending, uploading, bindInstance, addFiles, removeAttachment, clearAttachments };
});
```

- [ ] **Step 6: Wire `chat.send` to accept and forward attachments**

In `packages/relay-web/src/stores/chat.ts`, update `send` (~310-336). First ensure the `ChatMessage` type allows `attachments?: AttachmentMetadata[]` (add the field where `ChatMessage` is declared, importing `AttachmentMetadata` / `PromptAttachmentRef` from `@ganglion/xacpx-relay-protocol`). Then:

```typescript
  async function send(text: string, attachments: PromptAttachmentRef[] = []): Promise<void> {
    if (!instanceId.value || !sessionAlias.value) return;
    error.value = "";
    sending.value = true;
    const optimistic: ChatMessage = {
      instanceId: instanceId.value,
      sessionAlias: sessionAlias.value,
      direction: "in",
      text,
      createdAt: new Date().toISOString(),
      ...(attachments.length > 0
        ? { attachments: attachments.map((a) => ({ id: a.id, filename: a.fileName, mimeType: a.mimeType, size: a.size, kind: a.kind, ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}) })) }
        : {}),
    };
    messages.value.push(optimistic);
    try {
      const res = await api.rpc<{ ok?: boolean; errorMessage?: string }>(instanceId.value, "control.prompt", {
        sessionAlias: sessionAlias.value,
        text,
        ...(attachments.length > 0 ? { media: attachments } : {}),
      });
      if (res && res.ok === false) {
        error.value = res.errorMessage ?? "prompt-failed";
        optimistic.failed = true;
      }
    } catch (e) {
      const isTimeout = e instanceof ApiError && (e.status === 504 || e.code === "timeout");
      if (!isTimeout) {
        error.value = e instanceof ApiError ? e.code : "send-failed";
        optimistic.failed = true;
      }
    } finally {
      sending.value = false;
    }
  }
```

- [ ] **Step 7: Run the attachments test to verify it passes**

Run: `bun run --cwd packages/relay-web test -- attachments`
Expected: PASS (3 tests).

> The downscale path uses `createImageBitmap`/canvas which jsdom lacks — the test files are `text/plain` so `downscaleImage` returns early (non-image). No canvas mock needed.

- [ ] **Step 8: Run the full relay-web suite + typecheck**

Run: `bun run --cwd packages/relay-web test && npx vue-tsc --noEmit -p packages/relay-web/tsconfig.json`
Expected: PASS (existing 150+ tests + new ones; types clean).

- [ ] **Step 9: Commit**

```bash
git add packages/relay-web/src/api/client.ts packages/relay-web/src/lib/image-downscale.ts packages/relay-web/src/stores/composer.ts packages/relay-web/src/stores/chat.ts packages/relay-web/src/__tests__/attachments.test.ts
git commit -m "feat(relay-web): upload client, image downscale, composer attachments, send wiring"
```

---

### Task 7: relay-web UI — attach button, paste/drag, pending chips, message rendering

**Files:**
- Modify: `packages/relay-web/src/components/PromptInput.vue` (attach button + paste + drag; submit ~69)
- Modify: `packages/relay-web/src/components/ChatPane.vue` (wire composer attachments into `chat.send`; bind instance)
- Create: `packages/relay-web/src/components/MessageAttachments.vue`
- Modify: `packages/relay-web/src/components/MessageList.vue` (render attachments in user row ~147-170)
- Modify: relay-web i18n locale files (add `chat.attach.*` keys — grep for `chat.scheduled` to find them)
- Create: `packages/relay-web/src/__tests__/message-attachments.test.ts`

**Interfaces:**
- Consumes: composer store (`pending`, `addFiles`, `removeAttachment`, `clearAttachments`, `uploading`, `bindInstance`) from Task 6; `AttachmentMetadata` from Task 1.
- Produces: visible attach UI + `MessageAttachments.vue` rendering images as thumbnails and files as icon cards.

- [ ] **Step 1: Write the failing component test for MessageAttachments**

Create `packages/relay-web/src/__tests__/message-attachments.test.ts`:

```typescript
import { mount } from "@vue/test-utils";
import { expect, test } from "vitest";

import MessageAttachments from "../components/MessageAttachments.vue";

test("renders an image attachment as a thumbnail using previewUrl", () => {
  const wrapper = mount(MessageAttachments, {
    props: { attachments: [{ id: "1", filename: "a.png", mimeType: "image/png", size: 10, kind: "image", previewUrl: "data:image/png;base64,AA" }] },
  });
  const img = wrapper.find('[data-test="att-image"]');
  expect(img.exists()).toBe(true);
  expect(img.attributes("src")).toBe("data:image/png;base64,AA");
});

test("renders a non-image attachment as a file card with name + size", () => {
  const wrapper = mount(MessageAttachments, {
    props: { attachments: [{ id: "2", filename: "report.pdf", mimeType: "application/pdf", size: 2048, kind: "file" }] },
  });
  expect(wrapper.find('[data-test="att-file"]').exists()).toBe(true);
  expect(wrapper.text()).toContain("report.pdf");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/relay-web test -- message-attachments`
Expected: FAIL — cannot resolve `../components/MessageAttachments.vue`.

- [ ] **Step 3: Implement MessageAttachments.vue**

Create `packages/relay-web/src/components/MessageAttachments.vue`:

```vue
<script setup lang="ts">
import { FileText } from "lucide-vue-next";
import type { AttachmentMetadata } from "@ganglion/xacpx-relay-protocol";

defineProps<{ attachments: AttachmentMetadata[] }>();

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="mt-1 flex flex-wrap gap-2">
    <template v-for="a in attachments" :key="a.id">
      <img
        v-if="a.kind === 'image' && a.previewUrl"
        data-test="att-image"
        :src="a.previewUrl"
        :alt="a.filename"
        class="max-h-40 max-w-[200px] rounded-lg border border-border object-cover"
      />
      <div
        v-else
        data-test="att-file"
        class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]"
      >
        <FileText :size="16" class="shrink-0 text-muted" />
        <span class="max-w-[180px] truncate">{{ a.filename }}</span>
        <span class="text-muted">{{ fmtSize(a.size) }}</span>
      </div>
    </template>
  </div>
</template>
```

> `lucide-vue-next` is already a dependency (used by `MessageList.vue` `Clock`). If `FileText` is not exported in the installed version, use `File` instead. Match the project's Tailwind token classes (`border-border`, `bg-surface`, `text-muted`) — confirm these exist by grepping an existing component; if the palette differs, use the nearest existing tokens.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd packages/relay-web test -- message-attachments`
Expected: PASS (2 tests).

- [ ] **Step 5: Render attachments in the user message row**

In `packages/relay-web/src/components/MessageList.vue`, import the component in `<script setup>`:

```typescript
import MessageAttachments from "./MessageAttachments.vue";
```

Then inside the user row's bubble (`data-test="msg-in"` block, ~160-163), after the `<p>...</p>`, add:

```vue
                <p class="whitespace-pre-wrap text-[14px] leading-relaxed text-fg">{{ m.text }}</p>
                <MessageAttachments v-if="m.attachments?.length" :attachments="m.attachments" />
```

> Ensure the `ChatMessage` type used by `MessageList` carries `attachments?` (added in Task 6 step 6). If `MessageList` maps from `MessageRecordDto`, confirm the mapping copies `attachments` through.

- [ ] **Step 6: Add the attach button + paste + drag to PromptInput.vue**

In `packages/relay-web/src/components/PromptInput.vue`:

6a. Add imports + composer wiring in `<script setup>`:

```typescript
import { Paperclip, X } from "lucide-vue-next";
import { useComposerStore } from "../stores/composer";

const composer = useComposerStore();
const fileInput = ref<HTMLInputElement | null>(null);

function openPicker() {
  fileInput.value?.click();
}
async function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) await composer.addFiles(Array.from(input.files));
  input.value = "";
}
async function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length > 0) {
    e.preventDefault();
    await composer.addFiles(files);
  }
}
async function onDrop(e: DragEvent) {
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length > 0) {
    e.preventDefault();
    await composer.addFiles(files);
  }
}
```

6b. Update `submit()` (~69) to include ready attachments and clear them. Replace the `emit("send", value)` line:

```typescript
function submit() {
  if (props.busy) return;
  const ready = composer.pending.filter((p) => p.status === "ready");
  const value = text.value.trim();
  if (!value && ready.length === 0) return;
  if (composer.uploading) return; // wait for in-flight uploads
  const media = ready.map((p) => ({ id: p.id, filePath: p.filePath as string, fileName: p.filename, mimeType: p.mimeType, kind: p.kind, size: p.size, ...(p.previewUrl ? { previewUrl: p.previewUrl } : {}) }));
  emit("send", value, media);
  composer.clearAttachments();
  // ...keep the rest of the existing submit() body (history push, clear text, etc.)
}
```

6c. Update the `emit` type declaration to `(e: "send", text: string, media: PromptAttachmentRef[]): void` (import `PromptAttachmentRef` from `@ganglion/xacpx-relay-protocol`). Keep any other existing emits.

6d. In the template: add a hidden file input, an attach button next to the send button, the paste/drop handlers on the textarea/root, and a pending-chips strip. Add near the textarea:

```vue
    <input ref="fileInput" type="file" multiple class="hidden" data-test="attach-input" @change="onFilesPicked" />
    <button type="button" data-test="attach-btn" :title="$t('chat.attach.add')" class="..." @click="openPicker">
      <Paperclip :size="18" />
    </button>
```

Add `@paste="onPaste"` to the `<textarea>` and `@drop="onDrop" @dragover.prevent` to the composer root. Above the textarea, render the chips strip:

```vue
    <div v-if="composer.pending.length" class="flex flex-wrap gap-2 px-2 pt-2">
      <div v-for="p in composer.pending" :key="p.id" class="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[12px]">
        <img v-if="p.previewUrl" :src="p.previewUrl" class="h-6 w-6 rounded object-cover" :alt="p.filename" />
        <span class="max-w-[120px] truncate">{{ p.filename }}</span>
        <span v-if="p.status === 'uploading'" class="text-muted">…</span>
        <span v-else-if="p.status === 'error'" class="text-danger">!</span>
        <button type="button" :title="$t('chat.attach.remove')" @click="composer.removeAttachment(p.id)"><X :size="12" /></button>
      </div>
    </div>
```

> Match existing button/utility classes in this file rather than inventing new ones. Grep the file for the send button's classes and reuse them for the attach button.

- [ ] **Step 7: Wire ChatPane to pass media through + bind the instance**

In `packages/relay-web/src/components/ChatPane.vue`, find where it listens to `PromptInput`'s `send` and calls `chat.send(text)`. Update the handler to forward media:

```typescript
function onSend(text: string, media: PromptAttachmentRef[] = []) {
  void chat.send(text, media);
}
```

and the template binding: `@send="onSend"`. Also bind the composer to the active instance (e.g. in the existing watcher that reacts to `chat.instanceId`):

```typescript
import { useComposerStore } from "../stores/composer";
const composer = useComposerStore();
watch(() => chat.instanceId, (id) => { if (id) composer.bindInstance(id); }, { immediate: true });
```

> If `ChatPane` already exposes the active instance id under a different name, use that. Confirm the `resend` path (`emit('resend', m)`) still re-sends without attachments — that's acceptable for v1 (resend is text-only).

- [ ] **Step 8: Add i18n keys**

Find the locale files (grep `"scheduled"` under `packages/relay-web/src` for the `chat` namespace). Add to each locale (English + Chinese):

English:
```json
"attach": { "add": "Attach file", "remove": "Remove" }
```
Chinese:
```json
"attach": { "add": "添加附件", "remove": "移除" }
```

(nested under the existing `chat` object).

- [ ] **Step 9: Run the full relay-web suite + typecheck**

Run: `bun run --cwd packages/relay-web test && npx vue-tsc --noEmit -p packages/relay-web/tsconfig.json`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/relay-web/src/components/PromptInput.vue packages/relay-web/src/components/ChatPane.vue packages/relay-web/src/components/MessageList.vue packages/relay-web/src/components/MessageAttachments.vue packages/relay-web/src/__tests__/message-attachments.test.ts packages/relay-web/src/locales
git commit -m "feat(relay-web): attach button, paste/drag, pending chips, attachment rendering"
```

---

### Task 8: End-to-end validation + docs

**Files:**
- Modify: `docs/relay-web-module.md` (document the attachment surface)
- Modify: `docs/control-module.md` (document `control.upload` RPC + prompt `media`)

**Interfaces:** none (integration + documentation).

- [ ] **Step 1: Full build + typecheck + all unit suites**

Run:
```bash
bun run build:relay-protocol
bun run build
npx tsc --noEmit
npm test
bun run --cwd packages/relay test
bun run --cwd packages/relay-web test
```
Expected: all PASS.

- [ ] **Step 2: Real-relay end-to-end smoke (manual, mirrors HAPI-borrow/workspace-fs)**

Follow the sandbox full-stack procedure from prior relay work:
1. `bun run build` in this repo.
2. Refresh the installed connector copy (`cp -R` the connector `dist` into the test HOME `~/.xacpx/plugins/...`), and `rm -rf` any nested `node_modules/@ganglion/xacpx-relay-protocol` shadow copy so it resolves the refreshed sibling protocol.
3. Restart the console: `node dist/cli.js run` connected to the hub gateway.
4. In relay-web: select a session, click the attach button, pick a PNG, confirm the chip shows a thumbnail and "ready", send with text.
5. Verify the agent received the image (acpx `prompt.json` contains an `image` content block; check `~/.xacpx/runtime/app.log`).
6. Attach a non-image file (e.g. a `.txt`), send, verify the agent gets the `resource` block + the "Attachments available as local files:" path summary and can read it.
7. Reload the page; confirm the image thumbnail + file card re-display from persisted history.
8. Negative: attempt an >10MB file → rejected (413 / size error); confirm a `../`-named file lands sanitized under `~/.xacpx/runtime/uploads/`.

Record the results (pass/fail per step) in the commit message or PR description. If any step fails, fix before proceeding.

- [ ] **Step 3: Document the feature**

Add a section to `docs/relay-web-module.md` describing: attach button/paste/drag, ≤5 files, 10MB cap, image thumbnails vs file cards, persisted preview. Add to `docs/control-module.md`: the `control.upload` RPC (`UploadPayload`→`UploadResult`, non-chat-scoped, writes to `~/.xacpx/runtime/uploads/`, TTL 24h) and the `media` field on `control.prompt` (`PromptAttachmentRef[]` → ACP image/resource blocks; non-image files reach the agent as a daemon-absolute path the agent must have fs read access to).

- [ ] **Step 4: Commit**

```bash
git add docs/relay-web-module.md docs/control-module.md
git commit -m "docs: relay-web message attachments + control.upload RPC"
```

---

## Self-Review Notes

- **Spec coverage:** §3 data flow → Tasks 1,3,4,5,6,7. §4 layer changes → all tasks map (relay-web 6/7, protocol 1, hub 5, connector 4, core 2/3, "already wired" verified — no transport task). §5 params (10MB/5/512px/TTL/uploads dir) → Global Constraints + Tasks 2,5,6. §6 types → Task 1. §7 security (sanitize, dual size check, non-chat-scoped, file caveat) → Tasks 2,5,4, Task 8 docs. §8 tests → each task's TDD steps + Task 8 e2e. §10 YAGNI honored (no chunking/transcoding/audio-video UI/server archive/other channels).
- **Caveat carried:** non-image files reach the agent by absolute daemon path (resource block + text summary); agent needs fs read on the temp dir — documented in Task 8 step 3.
- **Type consistency:** `PromptAttachmentRef` ({id, filePath, fileName, mimeType, kind, size, previewUrl?}) and `AttachmentMetadata` ({id, filename, mimeType, size, kind, previewUrl?}) are used consistently; the web→hub persist mapping (`fileName`→`filename`, drop `filePath`) is explicit in Task 5 step 6 and Task 6 step 6.
