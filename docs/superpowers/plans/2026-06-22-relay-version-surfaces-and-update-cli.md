# Relay version surfaces + `xacpx-relay update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the relay hub version (with an "update available" hint) in the Settings page, show each instance's reported version in the Manage dialog, and add an `xacpx-relay update [--check]` CLI command.

**Architecture:** New `packages/relay/src/version.ts` (read own version, query npm latest, semver compare, cached update-checker) feeds both a new auth-gated `GET /api/version` endpoint and the new `cli-update.ts`. The web Settings view fetches `/api/version`; the Manage dialog renders the already-present `coreVersion` from the store. Spawn helpers live in `packages/relay/src/proc.ts`.

**Tech Stack:** TypeScript, Hono (relay HTTP), Vue 3 + Pinia + vue-i18n (relay-web), Bun test (relay server/CLI via `node ./scripts/run-tests.mjs`), Vitest (`bun run test:web`).

**Spec:** `docs/superpowers/specs/2026-06-22-relay-version-surfaces-and-update-cli-design.md`

**Conventions:**
- Relay server/CLI tests live in `tests/unit/packages/relay/*.test.ts`; run a single file with `node ./scripts/run-tests.mjs tests/unit/packages/relay/<file>.test.ts`.
- Web tests live in `packages/relay-web/src/__tests__/*.test.ts`; run all with `bun run test:web`.
- Final release: bump `@ganglion/xacpx-relay` to `0.7.0` (see Task 8). No core/protocol/channel-relay changes.

---

### Task 1: Spawn helpers (`proc.ts`)

**Files:**
- Create: `packages/relay/src/proc.ts`
- Test: `tests/unit/packages/relay/proc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/packages/relay/proc.test.ts
import { expect, test } from "bun:test";
import { runCapture } from "../../../../packages/relay/src/proc";

test("runCapture returns stdout and exit code 0 for a successful command", async () => {
  const r = await runCapture("node", ["-e", "process.stdout.write('hello')"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("hello");
});

test("runCapture reports a non-zero exit code", async () => {
  const r = await runCapture("node", ["-e", "process.exit(3)"]);
  expect(r.code).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/proc.test.ts`
Expected: FAIL — cannot find module `proc`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/relay/src/proc.ts
import { spawn } from "node:child_process";

// npm/bun resolve to .cmd shims on Windows, which Node refuses to spawn without a
// shell (EINVAL). Everything passed here is a fixed flag or an npm package spec
// (no spaces/metacharacters), so shell:true is safe. Do not reuse for paths.
const spawnUsesShell = (): boolean => process.platform === "win32";

export async function runCapture(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: spawnUsesShell(),
      timeout: opts.timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runInherit(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: spawnUsesShell() });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/proc.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/proc.ts tests/unit/packages/relay/proc.test.ts
git commit -m "feat(relay): spawn helpers (runCapture/runInherit) for version + update"
```

---

### Task 2: Version utilities (`version.ts`)

**Files:**
- Create: `packages/relay/src/version.ts`
- Test: `tests/unit/packages/relay/version.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/packages/relay/version.test.ts
import { expect, test } from "bun:test";
import { isNewer, readRelayVersion, createRelayUpdateChecker } from "../../../../packages/relay/src/version";

test("readRelayVersion reads the relay package.json version", () => {
  // Matches packages/relay/package.json — a semver string, not "unknown".
  expect(readRelayVersion()).toMatch(/^\d+\.\d+\.\d+/);
});

test("isNewer compares semver; a prerelease ranks below the same release", () => {
  expect(isNewer("0.7.0", "0.6.0")).toBe(true);
  expect(isNewer("0.6.0", "0.6.0")).toBe(false);
  expect(isNewer("0.6.0", "0.7.0")).toBe(false);
  expect(isNewer("0.7.0", "0.7.0-rc.1")).toBe(true);
});

test("update checker reports updateAvailable and caches the latest lookup", async () => {
  let calls = 0;
  let clock = 0;
  const check = createRelayUpdateChecker({
    current: "0.6.0",
    getLatest: async () => { calls += 1; return "0.7.0"; },
    now: () => clock,
    ttlMs: 1000,
  });
  expect(await check()).toEqual({ current: "0.6.0", latest: "0.7.0", updateAvailable: true });
  clock = 500; // within TTL → cached, no second call
  expect((await check()).latest).toBe("0.7.0");
  expect(calls).toBe(1);
  clock = 2000; // past TTL → refetch
  await check();
  expect(calls).toBe(2);
});

test("update checker tolerates a failing npm lookup (no poisoned cache)", async () => {
  let mode: "fail" | "ok" = "fail";
  const check = createRelayUpdateChecker({
    current: "0.6.0",
    getLatest: async () => (mode === "fail" ? null : "0.7.0"),
    now: () => 0,
    ttlMs: 1000,
  });
  expect(await check()).toEqual({ current: "0.6.0", latest: null, updateAvailable: false });
  mode = "ok"; // a null result must not have been cached → next call retries
  expect((await check()).latest).toBe("0.7.0");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/version.test.ts`
Expected: FAIL — cannot find module `version`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/relay/src/version.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCapture } from "./proc.js";

export const RELAY_PACKAGE_NAME = "@ganglion/xacpx-relay";

/** Read this relay build's own version from its package.json. Resolves against
 *  import.meta.url (same as resolveBundledWebRoot), so it works both from source
 *  (packages/relay/src) and from the bundled dist/cli.js. Falls back to "unknown". */
export function readRelayVersion(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  for (const candidate of [
    join(here, "package.json"),
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === RELAY_PACKAGE_NAME && typeof parsed.version === "string") return parsed.version;
    } catch { /* try next candidate */ }
  }
  return "unknown";
}

export async function getLatestNpmVersion(packageName: string): Promise<string | null> {
  const result = await runCapture("npm", ["view", packageName, "version", "--json"], { timeoutMs: 8000 });
  if (result.code !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return raw.replace(/^"|"$/g, "") || null;
  }
}

/** True when `candidate` >= compare numerically on major.minor.patch; a prerelease
 *  ranks below the same release (so a staging prerelease never trips "update available"). */
export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

function compareSemver(a: string, b: string): number {
  const parse = (value: string): { nums: number[]; prerelease: boolean } => {
    const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(-[^\s]*)?/.exec(value);
    if (!match) return { nums: [0, 0, 0], prerelease: false };
    return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: Boolean(match[4]) };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i]! !== right.nums[i]!) return left.nums[i]! < right.nums[i]! ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease ? -1 : 1;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

/** Build a cached update-checker. Only SUCCESSFUL latest lookups are cached (for
 *  ttlMs); a failed/null lookup leaves the cache untouched so the next call retries.
 *  Clock + fetcher are injectable for tests. */
export function createRelayUpdateChecker(opts: {
  current: string;
  getLatest?: () => Promise<string | null>;
  now?: () => number;
  ttlMs?: number;
}): () => Promise<UpdateCheck> {
  const getLatest = opts.getLatest ?? (() => getLatestNpmVersion(RELAY_PACKAGE_NAME));
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  let cache: { latest: string; at: number } | null = null;
  return async (): Promise<UpdateCheck> => {
    if (!cache || now() - cache.at >= ttlMs) {
      try {
        const latest = await getLatest();
        if (latest != null) cache = { latest, at: now() };
      } catch { /* keep any prior cache; report current-only below */ }
    }
    const latest = cache?.latest ?? null;
    return { current: opts.current, latest, updateAvailable: latest != null && isNewer(latest, opts.current) };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/version.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/version.ts tests/unit/packages/relay/version.test.ts
git commit -m "feat(relay): version util — read own version, npm latest, cached update check"
```

---

### Task 3: `GET /api/version` endpoint

**Files:**
- Modify: `packages/relay/src/http/app.ts` (add import, `AppDeps.checkUpdate`, route)
- Test: `tests/unit/packages/relay/http-app.test.ts` (add cases)

- [ ] **Step 1: Write the failing test** (append to `http-app.test.ts`)

```ts
test("GET /api/version returns the injected update check (auth required)", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const admin = accounts.createAccount("admin");
  const { token } = accounts.createLoginToken(admin.id, "test");
  const messages = new MessageStore(db);
  const gateway = { isOnline: () => true, sendRequest: async () => ({}) };
  const app = createApp({
    accounts, instances, gateway, messages,
    checkUpdate: async () => ({ current: "0.6.0", latest: "0.7.0", updateAvailable: true }),
  });
  // unauthenticated → 401
  expect((await app.request("/api/version")).status).toBe(401);
  // authenticated → the injected payload
  const login = await app.request("/api/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const res = await app.request("/api/version", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ current: "0.6.0", latest: "0.7.0", updateAvailable: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/http-app.test.ts`
Expected: FAIL — `/api/version` returns 404 (no route) so the authed assertion fails.

- [ ] **Step 3: Add the import** at the top of `packages/relay/src/http/app.ts` (after the existing local imports, e.g. after the `clientIp` import on line 10):

```ts
import { readRelayVersion, type UpdateCheck } from "../version.js";
```

- [ ] **Step 4: Extend `AppDeps`** — add this field inside the `export interface AppDeps { … }` block (after `maxMessagesPerSession?: number;`):

```ts
  /** Returns the hub's current version + whether a newer one is published. Injected
   *  by server.ts (cached). When omitted, /api/version reports current-only. */
  checkUpdate?: () => Promise<UpdateCheck>;
```

- [ ] **Step 5: Add the route** immediately after the `app.get("/api/config", …)` block (after line ~183):

```ts
  app.get("/api/version", async (c) => {
    const check = deps.checkUpdate
      ?? (async (): Promise<UpdateCheck> => ({ current: readRelayVersion(), latest: null, updateAvailable: false }));
    return c.json(await check());
  });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/http-app.test.ts`
Expected: PASS (existing + new case).

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/http/app.ts tests/unit/packages/relay/http-app.test.ts
git commit -m "feat(relay): GET /api/version (auth-gated, injectable update check)"
```

---

### Task 4: Wire the cached checker into the server

**Files:**
- Modify: `packages/relay/src/server.ts` (import + pass `checkUpdate` into `createApp`)
- Test: covered by Task 3 default-path + manual; add a light assertion in `http-app.test.ts`.

- [ ] **Step 1: Write the failing test** (append to `http-app.test.ts`) — the default path (no injection) reports current-only and never throws:

```ts
test("GET /api/version default path reports current-only without throwing", async () => {
  const { app, loginToken, login } = await makeApp();
  const { cookie } = await login(loginToken);
  const res = await app.request("/api/version", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.json() as { current: string; latest: string | null; updateAvailable: boolean };
  expect(typeof body.current).toBe("string");
  expect(body.latest).toBeNull();
  expect(body.updateAvailable).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it passes already** (the default branch from Task 3 handles this)

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/http-app.test.ts`
Expected: PASS. (This test guards the no-injection branch.)

- [ ] **Step 3: Add imports to `packages/relay/src/server.ts`** (near the `createApp` import on line 16):

```ts
import { createRelayUpdateChecker, readRelayVersion } from "./version.js";
```

- [ ] **Step 4: Pass `checkUpdate` into the `createApp({ … })` call** (the call starting at line ~159). Add this property alongside `historyRetentionDays` / `maxMessagesPerSession`:

```ts
    checkUpdate: createRelayUpdateChecker({ current: readRelayVersion() }),
```

- [ ] **Step 5: Verify the relay server still builds**

Run: `bun run build:relay`
Expected: builds; prints `bundled relay-web dashboard -> packages/relay/dist/relay-web`.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/server.ts tests/unit/packages/relay/http-app.test.ts
git commit -m "feat(relay): serve real hub version + cached update check from server"
```

---

### Task 5: Settings page — Relay version + update hint (web)

**Files:**
- Modify: `packages/relay-web/src/views/SettingsView.vue`
- Modify: `packages/relay-web/src/i18n/messages/en.ts`
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts`
- Modify: `packages/relay-web/src/__tests__/settings.test.ts`

- [ ] **Step 1: Add i18n keys.** In `en.ts`, inside the `settings: { … }` object, add after `retentionBody`:

```ts
    relayTitle: "Relay",
    relayVersion: "Relay v{version}",
    relayUpdateAvailable: "Update available: v{latest} — run `xacpx-relay update`",
```

In `zh-CN.ts`, inside its `settings: { … }` object at the matching spot:

```ts
    relayTitle: "Relay",
    relayVersion: "Relay v{version}",
    relayUpdateAvailable: "有可用更新：v{latest} — 运行 `xacpx-relay update`",
```

- [ ] **Step 2: Write the failing test** (append cases to `settings.test.ts`). Note: SettingsView now calls `api.get` for BOTH `/api/config` and `/api/version`, so these tests drive `get` by URL:

```ts
  it("shows the relay version from /api/version", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: null, updateAvailable: false })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(get).toHaveBeenCalledWith("/api/version");
    expect(w.get('[data-test="relay-version"]').text()).toContain("0.6.0");
    expect(w.find('[data-test="relay-update"]').exists()).toBe(false);
  });

  it("shows an update hint when a newer relay is available", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: "0.7.0", updateAvailable: true })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(w.get('[data-test="relay-update"]').text()).toContain("0.7.0");
  });
```

- [ ] **Step 3: Update existing settings tests** that used `get.mockResolvedValueOnce(...)` to instead tolerate the extra `/api/version` call. For each existing `it(...)` in `settings.test.ts` that calls `get.mockResolvedValueOnce({ historyRetention… })`, replace that line with a URL-aware implementation:

```ts
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: null, updateAvailable: false })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
```

(There are 3 such existing `it` blocks: "loads and shows the retention policy", "invite section does not exist for any user", "generates a pairing token…". The pairing-token test keeps its `post.mockResolvedValueOnce` line unchanged.)

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun run test:web -- settings`
Expected: FAIL — `[data-test="relay-version"]` not found (markup not added yet).

- [ ] **Step 5: Implement the view changes** in `SettingsView.vue`.

In `<script setup>`, add a ref and extend `onMounted`. Replace the existing `onMounted(async () => { … })` (lines 23-28) with:

```ts
const relay = ref<{ current: string; latest: string | null; updateAvailable: boolean } | null>(null);

onMounted(async () => {
  try {
    const cfg = await api.get<{ historyRetention: { days: number; maxPerSession: number } }>("/api/config");
    retention.value = cfg.historyRetention;
  } catch { /* leave null; UI shows a dash */ }
  try {
    relay.value = await api.get<{ current: string; latest: string | null; updateAvailable: boolean }>("/api/version");
  } catch { /* leave null; relay section shows a dash */ }
});
```

In the template, add a new section between the retention `</section>` (line 105) and the Account `<section>` (line 107):

```vue
    <section class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.relayTitle") }}</h2>
      <p class="text-sm text-fg-muted" data-test="relay-version">
        {{ $t("settings.relayVersion", { version: relay?.current ?? "—" }) }}
      </p>
      <p v-if="relay?.updateAvailable" class="mt-1 text-sm text-accent" data-test="relay-update">
        {{ $t("settings.relayUpdateAvailable", { latest: relay?.latest }) }}
      </p>
    </section>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test:web -- settings`
Expected: PASS (existing + 2 new cases).

- [ ] **Step 7: Commit**

```bash
git add packages/relay-web/src/views/SettingsView.vue packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/__tests__/settings.test.ts
git commit -m "feat(relay-web): show relay version + update hint in Settings"
```

---

### Task 6: Manage-instance dialog — instance version row (web)

**Files:**
- Modify: `packages/relay-web/src/components/ManageInstanceDialog.vue`
- Modify: `packages/relay-web/src/i18n/messages/en.ts`
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts`
- Modify: `packages/relay-web/src/__tests__/manageinstancedialog-rename.test.ts` (rename file conceptually stays; add cases)

- [ ] **Step 1: Add i18n keys.** In `en.ts`, inside the `instance: { … }` object (near the existing `coreVersion` key on line 153), add:

```ts
    versionLabel: "Instance version",
```

In `zh-CN.ts`, at the matching spot inside `instance: { … }`:

```ts
    versionLabel: "实例版本",
```

- [ ] **Step 2: Write the failing test** (append to `manageinstancedialog-rename.test.ts`). Extend the `mountDialog` helper to accept a coreVersion, then assert the row:

```ts
test("shows the instance version row from the store's coreVersion", async () => {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "old", online: true, lastSeenAt: null, coreVersion: "0.13.0",
    sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [],
  }];
  vi.spyOn(store, "loadFormOptions").mockResolvedValue(undefined as never);
  const w = mount(ManageInstanceDialog, {
    props: { instanceId: "i1", instanceName: "old" },
    global: { stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true } },
  });
  await flushPromises();
  expect(w.get('[data-test="instance-version"]').text()).toContain("0.13.0");
});

test("shows the unknown-version fallback when coreVersion is null", async () => {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "old", online: true, lastSeenAt: null, coreVersion: null,
    sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [],
  }];
  vi.spyOn(store, "loadFormOptions").mockResolvedValue(undefined as never);
  const w = mount(ManageInstanceDialog, {
    props: { instanceId: "i1", instanceName: "old" },
    global: { stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true } },
  });
  await flushPromises();
  expect(w.get('[data-test="instance-version"]').text().length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test:web -- manageinstancedialog`
Expected: FAIL — `[data-test="instance-version"]` not found.

- [ ] **Step 4: Implement the dialog changes** in `ManageInstanceDialog.vue`.

In `<script setup>`, after `const { t } = useI18n();` (line 12), add a computed for the instance's reported version:

```ts
import { computed, onMounted, ref } from "vue";
// ^ replace the existing `import { onMounted, ref } from "vue";` on line 2 with this.

const coreVersion = computed(() => store.byId(props.instanceId)?.coreVersion ?? null);
```

In the template, add a read-only section after the Name `</section>` (line 69) and before `<WorkspacesManager …>` (line 70):

```vue
        <section class="space-y-1">
          <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.versionLabel") }}</h3>
          <p class="text-sm text-fg-muted" data-test="instance-version">
            {{ coreVersion ? $t("instance.coreVersion", { version: coreVersion }) : $t("instance.coreVersionUnknown") }}
          </p>
        </section>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test:web -- manageinstancedialog`
Expected: PASS (existing rename cases + 2 new version cases).

- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/components/ManageInstanceDialog.vue packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/__tests__/manageinstancedialog-rename.test.ts
git commit -m "feat(relay-web): show instance version in the Manage dialog"
```

---

### Task 7: `xacpx-relay update` CLI command

**Files:**
- Create: `packages/relay/src/cli-update.ts`
- Modify: `packages/relay/src/cli.ts` (USAGE + dispatch)
- Test: `tests/unit/packages/relay/cli-update.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/packages/relay/cli-update.test.ts
import { expect, test } from "bun:test";
import { handleRelayUpdate } from "../../../../packages/relay/src/cli-update";

function makeIo() {
  const lines: string[] = [];
  return { lines, print: (l: string) => lines.push(l) };
}

test("--check reports current vs latest and does NOT install", async () => {
  const io = makeIo();
  let installed = false;
  const code = await handleRelayUpdate(["--check"], {
    readCurrentVersion: () => "0.6.0",
    getLatestVersion: async () => "0.7.0",
    updateSelf: async () => { installed = true; },
    print: io.print,
  });
  expect(code).toBe(0);
  expect(installed).toBe(false);
  expect(io.lines.join("\n")).toContain("0.7.0");
});

test("update installs when a newer version exists", async () => {
  const io = makeIo();
  let installed = false;
  const code = await handleRelayUpdate([], {
    readCurrentVersion: () => "0.6.0",
    getLatestVersion: async () => "0.7.0",
    updateSelf: async () => { installed = true; },
    print: io.print,
  });
  expect(code).toBe(0);
  expect(installed).toBe(true);
  expect(io.lines.join("\n")).toContain("updated to v0.7.0");
});

test("update is a no-op when already current", async () => {
  const io = makeIo();
  let installed = false;
  const code = await handleRelayUpdate([], {
    readCurrentVersion: () => "0.7.0",
    getLatestVersion: async () => "0.7.0",
    updateSelf: async () => { installed = true; },
    print: io.print,
  });
  expect(code).toBe(0);
  expect(installed).toBe(false);
  expect(io.lines.join("\n")).toContain("already up to date");
});

test("update exits 1 when the latest version is unknown", async () => {
  const io = makeIo();
  const code = await handleRelayUpdate([], {
    readCurrentVersion: () => "0.6.0",
    getLatestVersion: async () => null,
    updateSelf: async () => { throw new Error("should not run"); },
    print: io.print,
  });
  expect(code).toBe(1);
});

test("--check exits 0 even when the latest version is unknown", async () => {
  const io = makeIo();
  const code = await handleRelayUpdate(["--check"], {
    readCurrentVersion: () => "0.6.0",
    getLatestVersion: async () => null,
    updateSelf: async () => {},
    print: io.print,
  });
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/cli-update.test.ts`
Expected: FAIL — cannot find module `cli-update`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/relay/src/cli-update.ts
import { runInherit } from "./proc.js";
import { getLatestNpmVersion, isNewer, readRelayVersion, RELAY_PACKAGE_NAME } from "./version.js";

export interface RelayUpdateDeps {
  readCurrentVersion: () => string;
  getLatestVersion: () => Promise<string | null>;
  updateSelf: () => Promise<void>;
  print: (line: string) => void;
}

/** `xacpx-relay update [--check]` — self-update the hub package. `--check` only
 *  reports current vs latest. Returns the process exit code. */
export async function handleRelayUpdate(args: string[], deps: Partial<RelayUpdateDeps> = {}): Promise<number> {
  const readCurrent = deps.readCurrentVersion ?? (() => readRelayVersion());
  const getLatest = deps.getLatestVersion ?? (() => getLatestNpmVersion(RELAY_PACKAGE_NAME));
  const updateSelf = deps.updateSelf ?? defaultUpdateSelf;
  const print = deps.print ?? ((l: string) => console.log(l));
  const checkOnly = args.includes("--check");

  const current = readCurrent();
  const latest = await getLatest();

  if (latest == null) {
    if (checkOnly) {
      print(`current: v${current}; latest: unknown (could not reach npm)`);
      return 0;
    }
    print(`update failed: could not determine the latest ${RELAY_PACKAGE_NAME} version (is npm reachable?)`);
    return 1;
  }
  if (!isNewer(latest, current)) {
    print(`already up to date (v${current})`);
    return 0;
  }
  if (checkOnly) {
    print(`update available: v${current} → v${latest}  (run: xacpx-relay update)`);
    return 0;
  }
  print(`updating ${RELAY_PACKAGE_NAME}: v${current} → v${latest} …`);
  try {
    await updateSelf();
  } catch (error) {
    print(`update failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  print(`updated to v${latest}`);
  return 0;
}

async function defaultUpdateSelf(): Promise<void> {
  const spec = `${RELAY_PACKAGE_NAME}@latest`;
  const useBun = (process.env.PACKAGE_MANAGER ?? "").trim().toLowerCase() === "bun";
  if (useBun) {
    await runInherit("bun", ["add", "-g", spec]);
    return;
  }
  await runInherit("npm", ["install", "-g", spec]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/cli-update.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/cli-update.ts tests/unit/packages/relay/cli-update.test.ts
git commit -m "feat(relay): xacpx-relay update [--check] command"
```

---

### Task 8: Wire `update` into the relay CLI + USAGE

**Files:**
- Modify: `packages/relay/src/cli.ts`
- Test: `tests/unit/packages/relay/cli.test.ts` (add a case)

- [ ] **Step 1: Write the failing test** (append to `cli.test.ts`). Uses the existing `makeIo` helper in that file:

```ts
test("update --check prints current and latest without installing", async () => {
  const io = makeIo();
  // Force the npm lookup to fail fast so --check reports 'unknown' deterministically,
  // exercising the dispatch wiring (the behavior itself is covered in cli-update.test.ts).
  const prev = process.env.PATH;
  process.env.PATH = "";
  try {
    const code = await runRelayCli(["update", "--check"], io);
    expect(code).toBe(0);
    expect(io.lines.join("\n").toLowerCase()).toContain("current:");
  } finally {
    process.env.PATH = prev;
  }
});

test("unknown command prints usage including the update line", async () => {
  const io = makeIo();
  const code = await runRelayCli(["bogus"], io);
  expect(code).toBe(1);
  expect(io.lines.join("\n")).toContain("update");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/cli.test.ts`
Expected: FAIL — usage has no "update" line; `update` falls through to USAGE and returns 1.

- [ ] **Step 3: Add the import** to `packages/relay/src/cli.ts` (after the `createRelayRuntime`/`startRelayServer` import near the top):

```ts
import { handleRelayUpdate } from "./cli-update.js";
```

- [ ] **Step 4: Add the USAGE line.** In the `USAGE` array, add after the `"  rm token …"` line:

```ts
  "  update     [--check]   (self-update @ganglion/xacpx-relay; --check only reports)",
```

- [ ] **Step 5: Add the dispatch.** Inside `runRelayCli`, before the final `io.print(USAGE); return 1;`, add:

```ts
  // update [--check]
  if (args[0] === "update") {
    return await handleRelayUpdate(args.slice(1), { print: io.print });
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node ./scripts/run-tests.mjs tests/unit/packages/relay/cli.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/cli.ts tests/unit/packages/relay/cli.test.ts
git commit -m "feat(relay): wire 'update' into the xacpx-relay CLI + usage"
```

---

### Task 9: Full verification, version bump, CHANGELOG

**Files:**
- Modify: `packages/relay/package.json` (0.6.0 → 0.7.0)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the whole relay server/CLI suite + typecheck**

Run: `npx tsc --noEmit && node ./scripts/run-tests.mjs tests/unit/packages/relay`
Expected: tsc clean; all relay tests pass.

- [ ] **Step 2: Run the full web suite + relay build**

Run: `bun run test:web && bun run build:relay`
Expected: web tests pass; relay builds and bundles the dashboard.

- [ ] **Step 3: Bump the relay package version**

Edit `packages/relay/package.json`: `"version": "0.6.0"` → `"version": "0.7.0"`.

- [ ] **Step 4: Add a CHANGELOG entry** at the top of `CHANGELOG.md` (after `# Changelog`):

```markdown
## [relay 0.7.0] - 2026-06-22

A `@ganglion/xacpx-relay` release (the hub bundles the dashboard; core is unchanged).

### Added

- **Relay version in Settings.** The Settings page now shows the running hub version and, when a newer `@ganglion/xacpx-relay` is published, an "update available" hint pointing at `xacpx-relay update`. Backed by a new auth-gated `GET /api/version` whose npm lookup is cached (~1h) and failure-tolerant, so the page never blocks on npm.
- **Instance version in the Manage dialog.** The manage-instance dialog shows the connector's reported xacpx core version (falling back to an "unknown" note for pre-version connectors).
- **`xacpx-relay update [--check]`.** Self-updates the hub package via npm (or bun when `PACKAGE_MANAGER=bun`); `--check` reports current vs latest without installing.
```

- [ ] **Step 5: Run the full unit suite once more**

Run: `node ./scripts/run-tests.mjs tests/unit`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/package.json CHANGELOG.md
git commit -m "chore(release): @ganglion/xacpx-relay 0.7.0 — version surfaces + update CLI"
```

- [ ] **Step 7: Push the branch and open a PR** (do not release/tag yet — that's a separate `/release-to-github` step the user runs)

```bash
git push -u origin feat/relay-version-surfaces-and-update-cli
gh pr create --base main --title "feat(relay): version surfaces + xacpx-relay update CLI" --body "Implements docs/superpowers/specs/2026-06-22-relay-version-surfaces-and-update-cli-design.md"
```

---

## Self-Review notes

- **Spec coverage:** Feature 1 (hub version + update-available) → Tasks 2,3,4,5. Feature 2 (instance version) → Task 6. Feature 3 (update CLI) → Tasks 7,8. Shared `version.ts` → Task 2. Release/bump → Task 9. All spec sections map to a task.
- **Type consistency:** `UpdateCheck { current; latest; updateAvailable }` is defined in Task 2 and reused verbatim in Tasks 3/4/5. `RELAY_PACKAGE_NAME`, `isNewer`, `getLatestNpmVersion`, `createRelayUpdateChecker`, `readRelayVersion` all defined in Task 2 and imported by later tasks. `handleRelayUpdate(args, Partial<RelayUpdateDeps>)` defined in Task 7, called in Task 8.
- **Known coupling:** Task 5 changes how `settings.test.ts` mocks `api.get` (now two URLs). Step 3 of Task 5 explicitly updates the 3 pre-existing tests, so they won't break.
- **No protocol/core/channel-relay changes** — instance version reuses the existing `coreVersion` field already flowing end-to-end.
