# relay-web 「改动」交互重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix garbled CJK filenames + dead clicks in the relay-web 「改动」panel, group changes by Staged/Changes/Untracked, add full-path tooltips, and upgrade the file viewer to Shiki syntax highlighting with a structured (un-highlighted) diff view — matching HAPI's approach.

**Architecture:** Core layer (`workspace-fs`) switches git status to `-z` + `core.quotePath=false` (root-cause fix for encoding & click-not-found) and synthesizes untracked-file diffs via `git diff --no-index`. The relay-web frontend gains three pure libs (Shiki highlighter, unified-diff parser, change grouping) consumed by `FilesPanel` (grouped list + tooltips) and `FileViewer` (Shiki file highlighting + structured diff rows). No relay-protocol / control-bridge / control-service changes — the existing `{path, status}` payload already carries everything.

**Tech Stack:** Node + `execFile` git (core); Vue 3 + Pinia + Tailwind + vitest (relay-web); Shiki v3 (`shiki/core` + `@shikijs/langs` + `@shikijs/themes`) with the JavaScript regex engine (no WASM).

## Global Constraints

- **No protocol change.** Do not touch `packages/relay-protocol`, `packages/channel-relay/src/control-bridge.ts`, or `src/control/control-service.ts`. The grouping is derived frontend-side from `DiffFile.status` (the 2-char porcelain `XY`).
- **git invocation safety:** always `execFile` with an argument array (never a shell), always `["-C", root, ...]`, always pass `maxBuffer: GIT_MAX_BUFFER`. Read-only subcommands only.
- **relay-web tests run with vitest:** `cd packages/relay-web && npx vitest run <file>`. NEVER `bun test` for relay-web (jsdom needed; bun gives false failures).
- **Core unit tests run per-file with bun:** `bun test tests/unit/control/workspace-fs.test.ts` (never the whole `tests/unit` dir at once — state-leak false failures).
- **Shiki: JS engine, no WASM.** Use `createHighlighterCore` + `createJavaScriptRegexEngine({ forgiving: true })`. The entire highlighting module must be reachable only via dynamic `import()` so it stays out of the initial bundle.
- **diffs are NOT syntax-highlighted** (HAPI's deliberate trade). Only the whole-file viewer is highlighted.
- **Dark mode is the `.dark` class on `<html>`** (Tailwind `darkMode: "class"`). Shiki dual-theme CSS overrides must use the `.dark` selector, not `[data-theme]`.
- **CHANGELOG entries in English** (project convention); replies/commits otherwise per repo norms.
- **Branch:** all work on `feat/relay-web-changes-redesign` (already created off `main`; the spec is committed there).

---

### Task 1: Core — `-z` porcelain parsing (fix CJK names + renames)

**Files:**
- Modify: `src/control/workspace-fs.ts:200-214` (the status-list block inside `gitDiff`)
- Test: `tests/unit/control/workspace-fs.test.ts` (append to the `describe("WorkspaceFs git diff", …)` block, after the existing tests near line 175)

**Interfaces:**
- Consumes: existing `gitDiff(workspace, relPath?)` → `WorkspaceDiff` (`{ workspace, files: DiffFile[], diff, truncated, branch?, detached?, worktree? }`), `DiffFile = { path: string; status: string }`.
- Produces: `files[].path` now carries **raw (un-escaped) UTF-8** paths; renames list only the **new** path with `status[0] === "R"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/control/workspace-fs.test.ts` (inside the existing `describe("WorkspaceFs git diff", …)`, before its closing `});`):

```ts
  test("returns non-ASCII filenames unescaped (quotePath off + -z)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "首页.txt"), "hi\n"); // untracked, non-ASCII name
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.files.some((f) => f.path === "首页.txt" && f.status.includes("?"))).toBe(true);
    // The old plain --porcelain would have produced an octal-escaped, quoted path.
    expect(d.files.every((f) => !f.path.includes("\\"))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  test("lists only the new path for a staged rename", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "old.txt"), "one\n");
    git("add", "."); git("commit", "-qm", "init");
    git("mv", "old.txt", "新名.txt");
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g");
    expect(d.files.some((f) => f.path === "新名.txt" && f.status[0] === "R")).toBe(true);
    expect(d.files.some((f) => f.path === "old.txt")).toBe(false); // original path is consumed, not listed
    rmSync(repo, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/control/workspace-fs.test.ts`
Expected: FAIL — the non-ASCII test sees an escaped path like `"\351\246\226..."`, and the rename test finds `old.txt -> 新名.txt` not parsed (current code splits on `\n` and ` -> `).

- [ ] **Step 3: Replace the status-list block**

In `src/control/workspace-fs.ts`, replace lines 200-214 (the `// Changed-file list …` block):

```ts
    // Changed-file list (includes untracked as "??"). Use -z so non-ASCII paths come
    // through raw (never octal-escaped/quoted) and -c core.quotePath=false to be doubly sure;
    // otherwise a quoted path would mismatch the path we hand back to git for a single-file diff.
    const files: DiffFile[] = [];
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", root, "-c", "core.quotePath=false", "status", "--porcelain", "-z"],
        { maxBuffer: GIT_MAX_BUFFER },
      );
      const fields = stdout.split("\0");
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (!field) continue;
        const status = field.slice(0, 2);
        const path = field.slice(3);
        // In -z output a rename/copy emits the NEW path in this field, then the ORIGINAL
        // path as the next NUL-separated field (verified: `R  new\0old\0`). Consume & drop it.
        if (status[0] === "R" || status[0] === "C") i++;
        files.push({ path, status });
      }
    } catch {
      /* status failed — leave files empty, still try the diff */
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/control/workspace-fs.test.ts`
Expected: PASS (all git-diff tests, including the two new ones).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/control/workspace-fs.ts tests/unit/control/workspace-fs.test.ts
git commit -m "fix(control): parse git status with -z + core.quotePath=false so non-ASCII paths round-trip"
```

---

### Task 2: Core — synthesize untracked-file diffs via `git diff --no-index`

**Files:**
- Modify: `src/control/workspace-fs.ts:216-228` (the unified-diff block inside `gitDiff`, right after the status-list block from Task 1)
- Test: `tests/unit/control/workspace-fs.test.ts` (append to the same `describe`)

**Interfaces:**
- Consumes: `this.resolve(workspace, relPath)` already returns `{ root, rel }`; `rel` is the relative path (empty for whole-tree).
- Produces: when a single untracked file is requested, `WorkspaceDiff.diff` is a non-empty all-additions unified diff.

- [ ] **Step 1: Write the failing test**

Append inside `describe("WorkspaceFs git diff", …)`:

```ts
  test("synthesizes an all-additions diff for an untracked file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wsfs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "seed.txt"), "x\n");
    git("add", "."); git("commit", "-qm", "init");
    writeFileSync(join(repo, "untracked.txt"), "alpha\nbeta\n"); // never added
    const gfs = new WorkspaceFs(() => [{ name: "g", cwd: repo }]);
    const d = await gfs.gitDiff("g", "untracked.txt");
    expect(d.diff).toContain("+alpha");
    expect(d.diff).toContain("+beta");
    rmSync(repo, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/control/workspace-fs.test.ts`
Expected: FAIL — `d.diff` is empty (`git diff HEAD -- untracked.txt` shows nothing for an untracked file).

- [ ] **Step 3: Add the `--no-index` fallback**

In `src/control/workspace-fs.ts`, locate the diff block (now just after the Task 1 block):

```ts
    let diff = "";
    try {
      diff = (await execFileAsync("git", diffArgs(["diff", "HEAD"]), { maxBuffer: GIT_MAX_BUFFER })).stdout;
    } catch {
      try {
        diff = (await execFileAsync("git", diffArgs(["diff"]), { maxBuffer: GIT_MAX_BUFFER })).stdout;
      } catch {
        diff = "";
      }
    }
```

Insert, immediately after that `try/catch` (before the `const truncated = …` line):

```ts
    // Untracked files never appear in `git diff [HEAD]`. For a single requested file with
    // no tracked diff, synthesize an all-additions diff vs /dev/null so the viewer shows it.
    // `git diff --no-index` exits 1 ("differences found") → execFile rejects with the diff on stdout.
    if (rel && !diff) {
      try {
        diff = (await execFileAsync(
          "git",
          ["-C", root, "-c", "core.quotePath=false", "diff", "--no-index", "--", "/dev/null", rel],
          { maxBuffer: GIT_MAX_BUFFER },
        )).stdout;
      } catch (e) {
        const out = (e as { stdout?: string }).stdout;
        if (typeof out === "string") diff = out;
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/control/workspace-fs.test.ts`
Expected: PASS (new test + all existing git-diff tests; confirm the original "reports changed files and a unified diff" still passes — whole-tree diff unaffected because `rel` is empty there).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/control/workspace-fs.ts tests/unit/control/workspace-fs.test.ts
git commit -m "feat(control): synthesize an all-additions diff for untracked files via git diff --no-index"
```

---

### Task 3: relay-web — Shiki highlighter lib + deps + CSS + size measurement

**Files:**
- Modify: `packages/relay-web/package.json` (add deps)
- Create: `packages/relay-web/src/lib/shiki.ts`
- Modify: `packages/relay-web/src/style.css` (append Shiki CSS block)
- Test: `packages/relay-web/src/__tests__/shiki.test.ts`

**Interfaces:**
- Produces:
  - `langAlias: Record<string, string>`
  - `resolveLang(pathOrLang?: string): string` — file path or bare lang → Shiki lang id, defaulting to `"text"`.
  - `highlightToHtml(code: string, lang: string): Promise<string>` — Shiki dual-theme HTML; unknown langs fall back to plain text.

- [ ] **Step 1: Add dependencies**

Run from `packages/relay-web`:

```bash
cd packages/relay-web && bun add shiki@^3.20.0 @shikijs/langs@^3.20.0 @shikijs/themes@^3.20.0
```

Expected: `package.json` gains the three deps; `bun.lock` updates. (If `bun add` is unavailable in the sandbox, hand-edit `package.json` dependencies and run `bun install`.)

- [ ] **Step 2: Write the failing test (pure resolveLang/langAlias)**

Create `packages/relay-web/src/__tests__/shiki.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveLang, langAlias } from "../lib/shiki";

describe("resolveLang", () => {
  it("maps file extensions to shiki languages", () => {
    expect(resolveLang("src/a.ts")).toBe("typescript");
    expect(resolveLang("x.py")).toBe("python");
    expect(resolveLang("Component.vue")).toBe("vue");
    expect(resolveLang("deep/path/to/首页.tsx")).toBe("tsx");
  });
  it("falls back to text for unknown / missing / plaintext", () => {
    expect(resolveLang(undefined)).toBe("text");
    expect(resolveLang("README")).toBe("readme"); // no extension → bare token, lowercased
    expect(resolveLang("notes.txt")).toBe("text");
    expect(resolveLang("data.unknownext")).toBe("unknownext");
  });
  it("exposes a language alias table", () => {
    expect(langAlias.js).toBe("javascript");
    expect(langAlias.yml).toBe("yaml");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/__tests__/shiki.test.ts`
Expected: FAIL — `../lib/shiki` does not exist.

- [ ] **Step 4: Create the Shiki lib**

Create `packages/relay-web/src/lib/shiki.ts`:

```ts
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Dual themes, statically (but dynamically-imported, so this whole module code-splits).
const THEMES = [
  import("@shikijs/themes/github-light"),
  import("@shikijs/themes/github-dark"),
];
// Hand-picked common languages. Each is a separate dynamic import → one lazy chunk on first use.
const LANGS = [
  import("@shikijs/langs/shellscript"),
  import("@shikijs/langs/json"),
  import("@shikijs/langs/yaml"),
  import("@shikijs/langs/toml"),
  import("@shikijs/langs/xml"),
  import("@shikijs/langs/markdown"),
  import("@shikijs/langs/html"),
  import("@shikijs/langs/css"),
  import("@shikijs/langs/scss"),
  import("@shikijs/langs/javascript"),
  import("@shikijs/langs/typescript"),
  import("@shikijs/langs/jsx"),
  import("@shikijs/langs/tsx"),
  import("@shikijs/langs/vue"),
  import("@shikijs/langs/sql"),
  import("@shikijs/langs/graphql"),
  import("@shikijs/langs/c"),
  import("@shikijs/langs/cpp"),
  import("@shikijs/langs/rust"),
  import("@shikijs/langs/go"),
  import("@shikijs/langs/java"),
  import("@shikijs/langs/kotlin"),
  import("@shikijs/langs/python"),
  import("@shikijs/langs/php"),
  import("@shikijs/langs/ruby"),
  import("@shikijs/langs/swift"),
  import("@shikijs/langs/csharp"),
  import("@shikijs/langs/dockerfile"),
  import("@shikijs/langs/make"),
  import("@shikijs/langs/diff"),
];
const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

export const langAlias: Record<string, string> = {
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  yml: "yaml", md: "markdown", htm: "html",
  py: "python", rs: "rust", kt: "kotlin", cs: "csharp", rb: "ruby",
  cc: "cpp", hpp: "cpp", h: "c",
  gql: "graphql", makefile: "make",
};

/** Map a file path (or bare language id) to a Shiki language id, defaulting to "text". */
export function resolveLang(pathOrLang?: string): string {
  if (!pathOrLang) return "text";
  const base = pathOrLang.includes(".") ? pathOrLang.split(".").pop()! : pathOrLang;
  const key = base.toLowerCase().trim();
  if (key === "text" || key === "plaintext" || key === "txt") return "text";
  return langAlias[key] ?? key;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: THEMES,
      langs: LANGS,
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

/** Highlight code to Shiki dual-theme HTML. Unknown languages fall back to plain text. */
export async function highlightToHtml(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const resolved = lang !== "text" && hl.getLoadedLanguages().includes(lang) ? lang : "text";
  return hl.codeToHtml(code, { lang: resolved, themes: SHIKI_THEMES, defaultColor: false });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/shiki.test.ts`
Expected: PASS.

- [ ] **Step 6: Append Shiki CSS**

Append to `packages/relay-web/src/style.css`:

```css
/* Shiki syntax highlighting — dual theme via CSS vars, line numbers via counters. */
.shiki,
.shiki span {
  background-color: transparent !important;
  color: var(--shiki-light);
}
.dark .shiki,
.dark .shiki span {
  color: var(--shiki-dark);
}
.shiki {
  margin: 0;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.6;
}
.shiki code {
  display: grid;
  counter-reset: shiki-ln;
}
.shiki code .line {
  position: relative;
  padding-left: 3.25rem;
  min-height: 1.6em;
}
.shiki code .line::before {
  counter-increment: shiki-ln;
  content: counter(shiki-ln);
  position: absolute;
  left: 0;
  width: 2.75rem;
  text-align: right;
  opacity: 0.45;
  user-select: none;
}
```

- [ ] **Step 7: Measure the bundle (size gate)**

Run from `packages/relay-web`:

```bash
bun run build && ls -lh dist/assets/*.js | sort -k5 -h | tail -20
```

Expected: the build succeeds and Shiki lands in **its own lazy chunk(s)** (filenames containing `shiki`/lang ids), NOT folded into the main `index-*.js`. Record the largest Shiki-related chunk size in the commit message. **Gate:** first-open Shiki chunk(s) should total under ~200 KB gzipped (raw ~600 KB is fine since it's gzip-served and lazy). If the highlighter is in the main entry chunk instead, ensure `src/lib/shiki.ts` is only ever imported via dynamic `import()` (Task 6) — static imports would pull it into the entry. If the gate is badly blown, STOP and flag for a highlight.js fallback before continuing.

- [ ] **Step 8: Commit**

```bash
git add packages/relay-web/package.json packages/relay-web/bun.lock packages/relay-web/src/lib/shiki.ts packages/relay-web/src/__tests__/shiki.test.ts packages/relay-web/src/style.css
git commit -m "feat(relay-web): add lazy Shiki highlighter lib (JS engine, dual theme) [chunk: <SIZE>]"
```

---

### Task 4: relay-web — unified-diff parser lib

**Files:**
- Create: `packages/relay-web/src/lib/unified-diff.ts`
- Test: `packages/relay-web/src/__tests__/unified-diff.test.ts`

**Interfaces:**
- Produces:
  - `type DiffRowType = "hunk" | "add" | "del" | "context"`
  - `interface DiffRow { type: DiffRowType; oldNo: number | null; newNo: number | null; text: string }`
  - `interface ParsedDiff { rows: DiffRow[]; add: number; del: number }`
  - `parseUnifiedDiff(diff: string): ParsedDiff`

- [ ] **Step 1: Write the failing test**

Create `packages/relay-web/src/__tests__/unified-diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../lib/unified-diff";

describe("parseUnifiedDiff", () => {
  it("parses a simple modify hunk with correct line numbers", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "index 111..222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@ section heading",
      " one",
      "-two",
      "+TWO",
      " three",
    ].join("\n");
    const { rows, add, del } = parseUnifiedDiff(diff);
    expect(add).toBe(1);
    expect(del).toBe(1);
    // file-header lines (diff/index/---/+++) are dropped
    expect(rows.map((r) => r.type)).toEqual(["hunk", "context", "del", "add", "context"]);
    const hunk = rows[0];
    expect(hunk.text).toBe("section heading");
    const ctx1 = rows[1];
    expect(ctx1).toMatchObject({ oldNo: 1, newNo: 1, text: "one" });
    const del2 = rows[2];
    expect(del2).toMatchObject({ type: "del", oldNo: 2, newNo: null, text: "two" });
    const add2 = rows[3];
    expect(add2).toMatchObject({ type: "add", oldNo: null, newNo: 2, text: "TWO" });
    const ctx3 = rows[4];
    expect(ctx3).toMatchObject({ oldNo: 3, newNo: 3, text: "three" });
  });

  it("handles an all-additions (untracked) diff vs /dev/null", () => {
    const diff = [
      "diff --git a/dev/null b/n.txt",
      "--- /dev/null",
      "+++ b/n.txt",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
    ].join("\n");
    const { rows, add, del } = parseUnifiedDiff(diff);
    expect(add).toBe(2);
    expect(del).toBe(0);
    expect(rows.filter((r) => r.type === "add").map((r) => r.newNo)).toEqual([1, 2]);
  });

  it("returns no rows for empty diff text", () => {
    expect(parseUnifiedDiff("")).toEqual({ rows: [], add: 0, del: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/unified-diff.test.ts`
Expected: FAIL — `../lib/unified-diff` does not exist.

- [ ] **Step 3: Create the parser**

Create `packages/relay-web/src/lib/unified-diff.ts`:

```ts
export type DiffRowType = "hunk" | "add" | "del" | "context";

export interface DiffRow {
  type: DiffRowType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface ParsedDiff {
  rows: DiffRow[];
  add: number;
  del: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Parse git unified-diff text into renderable rows with old/new line numbers.
 *  File-header lines (diff --git, index, ---, +++) are dropped; only hunks render. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let add = 0;
  let del = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ type: "hunk", oldNo: null, newNo: null, text: hunk[3].trim() });
      continue;
    }
    if (!inHunk) continue; // skip pre-hunk file headers / preamble
    const c = line[0];
    if (c === "+") {
      if (line.startsWith("+++")) continue;
      rows.push({ type: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo++;
      add++;
    } else if (c === "-") {
      if (line.startsWith("---")) continue;
      rows.push({ type: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo++;
      del++;
    } else if (c === " ") {
      rows.push({ type: "context", oldNo, newNo, text: line.slice(1) });
      oldNo++;
      newNo++;
    }
    // "\\ No newline at end of file" and blank trailing lines are ignored
  }
  return { rows, add, del };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/unified-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/lib/unified-diff.ts packages/relay-web/src/__tests__/unified-diff.test.ts
git commit -m "feat(relay-web): add unified-diff parser (rows + line numbers + add/del stats)"
```

---

### Task 5: relay-web — change grouping lib + grouped FilesPanel list with tooltips

**Files:**
- Create: `packages/relay-web/src/lib/change-groups.ts`
- Modify: `packages/relay-web/src/components/FilesPanel.vue` (script: add imports/computed/collapse state; template: replace the changed-files `<ul>` at lines 265-275)
- Modify: `packages/relay-web/src/i18n/messages/en.ts` and `packages/relay-web/src/i18n/messages/zh-CN.ts` (add `files.staged`, `files.untracked`)
- Test: `packages/relay-web/src/__tests__/change-groups.test.ts` (new) and `packages/relay-web/src/__tests__/filespanel.test.ts` (append)

**Interfaces:**
- Consumes: `files.diff.files` (`DiffFile[]`), existing `statusBadge(code)` and `openDiff(path)` in FilesPanel.
- Produces:
  - `interface ChangeEntry { path: string; status: string }`
  - `interface ChangeGroups { staged: ChangeEntry[]; changes: ChangeEntry[]; untracked: ChangeEntry[] }`
  - `groupChanges(files: ChangeEntry[]): ChangeGroups`
  - `splitPath(rel: string): { dir: string; name: string }`

- [ ] **Step 1: Write the failing grouping test**

Create `packages/relay-web/src/__tests__/change-groups.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupChanges, splitPath } from "../lib/change-groups";

describe("groupChanges", () => {
  it("buckets by porcelain XY: X=staged, Y=worktree, ??=untracked", () => {
    const g = groupChanges([
      { path: "a.ts", status: "M " }, // staged only
      { path: "b.ts", status: " M" }, // worktree change only
      { path: "c.ts", status: "MM" }, // both
      { path: "d.ts", status: "A " }, // staged add
      { path: "e.ts", status: "??" }, // untracked
    ]);
    expect(g.staged.map((f) => f.path)).toEqual(["a.ts", "c.ts", "d.ts"]);
    expect(g.changes.map((f) => f.path)).toEqual(["b.ts", "c.ts"]);
    expect(g.untracked.map((f) => f.path)).toEqual(["e.ts"]);
  });
});

describe("splitPath", () => {
  it("splits a relative path into dir prefix + basename", () => {
    expect(splitPath("src/deep/首页.ts")).toEqual({ dir: "src/deep/", name: "首页.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/change-groups.test.ts`
Expected: FAIL — `../lib/change-groups` does not exist.

- [ ] **Step 3: Create the grouping lib**

Create `packages/relay-web/src/lib/change-groups.ts`:

```ts
export interface ChangeEntry {
  path: string;
  status: string;
}

export interface ChangeGroups {
  staged: ChangeEntry[];
  changes: ChangeEntry[];
  untracked: ChangeEntry[];
}

/** Bucket porcelain entries: X (index) → Staged, Y (worktree) → Changes, "??" → Untracked.
 *  A both-staged-and-modified file intentionally appears in both Staged and Changes. */
export function groupChanges(files: ChangeEntry[]): ChangeGroups {
  const staged: ChangeEntry[] = [];
  const changes: ChangeEntry[] = [];
  const untracked: ChangeEntry[] = [];
  for (const f of files) {
    if (f.status === "??") {
      untracked.push(f);
      continue;
    }
    const x = f.status[0] ?? " ";
    const y = f.status[1] ?? " ";
    if (x !== " " && x !== "?") staged.push(f);
    if (y !== " " && y !== "?") changes.push(f);
  }
  return { staged, changes, untracked };
}

/** Split a workspace-relative path into a directory prefix (with trailing /) and basename. */
export function splitPath(rel: string): { dir: string; name: string } {
  const i = rel.lastIndexOf("/");
  return i < 0 ? { dir: "", name: rel } : { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/change-groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Add i18n keys**

In `packages/relay-web/src/i18n/messages/en.ts`, inside the `files: { … }` block (after line 144 `changes: "Changes",`), add:

```ts
    staged: "Staged",
    untracked: "Untracked",
```

In `packages/relay-web/src/i18n/messages/zh-CN.ts`, find the matching `files: { … }` block's `changes:` entry and add alongside it:

```ts
    staged: "暂存",
    untracked: "未跟踪",
```

- [ ] **Step 6: Wire FilesPanel script**

In `packages/relay-web/src/components/FilesPanel.vue`, add to the imports near line 5:

```ts
import { groupChanges, splitPath } from "../lib/change-groups";
```

Then add, after the `changesSummary` computed (after line 51):

```ts
// Three-way grouping of the changed-files list (Staged / Changes / Untracked). Empty groups hide.
const changeSections = computed(() => {
  const g = groupChanges(files.diff?.files ?? []);
  return [
    { key: "staged", items: g.staged },
    { key: "changes", items: g.changes },
    { key: "untracked", items: g.untracked },
  ].filter((s) => s.items.length);
});

// Per-group collapse state, persisted (sibling of the xacpx.* prefs).
const COLLAPSE_KEY = "xacpx.changes.collapsed";
const collapsed = ref<Record<string, boolean>>(loadCollapsed());
function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
function toggleGroup(key: string): void {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed.value));
  } catch {
    /* private mode / quota — collapse just won't persist */
  }
}
```

(`ref` and `computed` are already imported on line 2.)

- [ ] **Step 7: Replace the changed-files list template**

In `FilesPanel.vue`, replace the `<ul>…</ul>` block at lines 265-275 (the flat `v-for="f in files.diff.files"` list) with:

```html
          <div class="min-h-0 flex-1 overflow-y-auto thin-scroll p-2.5 space-y-2">
            <div v-for="s in changeSections" :key="s.key" data-test="change-group">
              <button class="flex w-full items-center gap-1.5 px-1 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted transition-colors hover:text-fg"
                      @click="toggleGroup(s.key)">
                <ChevronRight :size="11" class="shrink-0 transition-transform" :class="collapsed[s.key] ? '' : 'rotate-90'" />
                <span>{{ $t(`files.${s.key}`) }}</span>
                <span class="text-fg-muted/60">{{ s.items.length }}</span>
              </button>
              <ul v-show="!collapsed[s.key]" class="space-y-px pt-0.5">
                <li v-for="f in s.items" :key="f.path">
                  <button data-test="diff-file" :title="f.path"
                          class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left cursor-pointer"
                          :class="files.diffPath === f.path ? 'bg-accent/10' : 'hover:bg-raised'" @click="openDiff(f.path)">
                    <span class="w-3 shrink-0 text-center font-mono text-[10.5px] uppercase" :class="statusBadge(f.status).cls">{{ statusBadge(f.status).label }}</span>
                    <span class="flex min-w-0 flex-1 items-baseline truncate font-mono text-[11px]">
                      <span v-if="splitPath(f.path).dir" class="truncate text-fg-muted/70">{{ splitPath(f.path).dir }}</span>
                      <span class="shrink-0" :class="files.diffPath === f.path ? 'text-accent' : 'text-fg'">{{ splitPath(f.path).name }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </div>
            <div v-if="!changeSections.length" class="px-1.5 py-1 text-xs text-fg-muted">{{ $t("files.noChanges") }}</div>
          </div>
```

(Note: `splitPath` and `statusBadge` are called in-template; both are cheap and lists are small.)

- [ ] **Step 8: Write the failing FilesPanel test**

Append to `packages/relay-web/src/__tests__/filespanel.test.ts` (inside the existing `describe(…)`, before its closing `});`):

```ts
  it("groups changed files into Staged / Changes / Untracked with full-path tooltips", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.diff = {
      workspace: "ws",
      files: [
        { path: "src/staged.ts", status: "M " },
        { path: "src/work.ts", status: " M" },
        { path: "notes/草稿.md", status: "??" },
      ],
      diff: "",
      truncated: false,
    } as never;
    await w.vm.$nextTick();
    const groups = w.findAll('[data-test="change-group"]');
    expect(groups.length).toBe(3); // staged, changes, untracked all non-empty
    const rows = w.findAll('[data-test="diff-file"]');
    // the untracked CJK path renders raw and carries a full-path tooltip
    const cjk = rows.find((r) => r.attributes("title") === "notes/草稿.md");
    expect(cjk).toBeTruthy();
    expect(cjk!.text()).toContain("草稿.md");
  });
```

- [ ] **Step 9: Run FilesPanel + grouping tests**

Run: `npx vitest run src/__tests__/change-groups.test.ts src/__tests__/filespanel.test.ts`
Expected: PASS (new grouping test + all pre-existing FilesPanel tests — the Files-tab badge tests are untouched).

- [ ] **Step 10: Commit**

```bash
git add packages/relay-web/src/lib/change-groups.ts packages/relay-web/src/__tests__/change-groups.test.ts packages/relay-web/src/components/FilesPanel.vue packages/relay-web/src/__tests__/filespanel.test.ts packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts
git commit -m "feat(relay-web): group changes by Staged/Changes/Untracked with full-path tooltips"
```

---

### Task 6: relay-web — FileViewer Shiki file highlighting + structured diff rows

**Files:**
- Modify: `packages/relay-web/src/components/FileViewer.vue` (script: imports, highlight watch, `parsedDiff` computed, drop `diffLineClass`; template: file body + diff body)
- Test: `packages/relay-web/src/__tests__/fileviewer.test.ts` (update the gutter test + diff test; add a highlight test; mock the Shiki lib)

**Interfaces:**
- Consumes: `highlightToHtml`, `resolveLang` (Task 3); `parseUnifiedDiff` (Task 4); existing `files.file`, `files.diff`, `files.diffPath`.
- Produces: no new exports (component-internal).

- [ ] **Step 1: Update the FileViewer tests (and mock Shiki)**

In `packages/relay-web/src/__tests__/fileviewer.test.ts`, add the mock + import at the top (after line 3's vitest import, before the `FileViewer` import on line 4):

```ts
import { flushPromises } from "@vue/test-utils";

vi.mock("../lib/shiki", () => ({
  resolveLang: () => "text",
  // deterministic stand-in so jsdom never loads the real engine
  highlightToHtml: (code: string) => Promise.resolve(`<pre class="shiki"><code><span class="line">${code}</span></code></pre>`),
}));
```

Replace the first test ("renders a numbered gutter with one row per line", lines 15-25) with:

```ts
  it("renders the file content and upgrades it to highlighted HTML", async () => {
    vi.useFakeTimers();
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "src/a.ts", content: "one\ntwo\nthree", size: 13, truncated: false, binary: false };
    await w.vm.$nextTick();
    // immediate plain fallback shows the content before highlighting resolves
    const body = w.find('[data-test="fv-file-body"]');
    expect(body.exists()).toBe(true);
    expect(body.text()).toContain("one");
    expect(body.text()).toContain("three");
    // after the 150ms debounce + async highlight, Shiki HTML replaces the fallback
    vi.advanceTimersByTime(200);
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.find('[data-test="fv-file-body"]').html()).toContain("shiki");
    vi.useRealTimers();
  });
```

Replace the diff test ("renders a single-file diff when a diff path is selected", lines 74-83) with:

```ts
  it("renders a single-file diff as structured rows", async () => {
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.diffPath = "src/a.ts";
    files.diff = { workspace: "ws", files: [{ path: "src/a.ts", status: " M" }], diff: "@@ -1 +1 @@\n-old\n+new", truncated: false };
    await w.vm.$nextTick();
    const body = w.find('[data-test="fv-diff-body"]');
    expect(body.exists()).toBe(true);
    const rows = w.findAll('[data-test="fv-diff-row"]');
    // hunk header + one del + one add
    expect(rows.length).toBe(3);
    expect(body.text()).toContain("old");
    expect(body.text()).toContain("new");
  });
```

(The binary/back/close/copy tests are unaffected.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/fileviewer.test.ts`
Expected: FAIL — `fv-diff-row` doesn't exist yet and the highlight upgrade isn't implemented.

- [ ] **Step 3: Rewrite the FileViewer script**

In `packages/relay-web/src/components/FileViewer.vue`, replace the `<script setup>` block (lines 1-35) with:

```ts
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, FileText, FileDiff, X } from "lucide-vue-next";
import { useFilesStore } from "../stores/files";
import { highlightToHtml, resolveLang } from "../lib/shiki";
import { parseUnifiedDiff } from "../lib/unified-diff";
import CopyButton from "./CopyButton.vue";

// Roomy file/diff viewer that takes over the center column (the chat area) so file
// content isn't squeezed into the narrow right rail. The rail keeps navigation; this
// shows the selected file or single-file diff full-width, with a Back affordance.
const emit = defineEmits<{ back: []; close: [] }>();
const files = useFilesStore();

// Above this many lines we skip Shiki and render a plain <pre> so a huge file doesn't
// stall the highlighter or emit an enormous DOM.
const LINE_GUTTER_LIMIT = 5000;
const fileLines = computed(() => {
  const f = files.file;
  if (!f || f.binary) return [];
  return f.content.split("\n");
});

// Highlighted file HTML (Shiki). Empty until the first highlight resolves; while empty we
// render a plain <pre> fallback. Debounced 150ms (cheap protection against rapid refreshes).
const fileHtml = ref("");
let hlTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [files.file?.path, files.file?.content, files.file?.binary] as const,
  ([path, content, binary]) => {
    if (hlTimer) clearTimeout(hlTimer);
    fileHtml.value = "";
    if (!files.file || binary || content === undefined) return;
    if (fileLines.value.length > LINE_GUTTER_LIMIT) return; // plain fallback for huge files
    const code = content;
    const lang = resolveLang(path);
    hlTimer = setTimeout(() => {
      void highlightToHtml(code, lang).then((html) => {
        // ignore a stale result if the file changed while we were highlighting
        if (files.file?.content === code) fileHtml.value = html;
      });
    }, 150);
  },
  { immediate: true },
);

// Structured rows for the single-file diff (HAPI-style tinted rows; not syntax-highlighted).
const parsedDiff = computed(() => (files.diff?.diff ? parseUnifiedDiff(files.diff.diff) : null));

function fmtSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
</script>
```

- [ ] **Step 4: Rewrite the FileViewer body template**

In `FileViewer.vue`, replace the `<!-- body -->` section (lines 67-86 — from `<div class="min-h-0 flex-1 overflow-auto thin-scroll">` through its closing `</div>` before `</template>`) with:

```html
    <!-- body -->
    <div class="min-h-0 flex-1 overflow-auto thin-scroll">
      <!-- file content -->
      <template v-if="files.file">
        <div v-if="!files.file.binary && fileLines.length <= LINE_GUTTER_LIMIT" data-test="fv-file-body">
          <div v-if="fileHtml" v-html="fileHtml"></div>
          <pre v-else class="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg whitespace-pre">{{ files.file.content }}</pre>
        </div>
        <pre v-else-if="!files.file.binary" data-test="fv-file-body" class="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg whitespace-pre">{{ files.file.content }}</pre>
        <div v-else class="p-6 text-sm text-fg-muted">{{ $t("files.binaryNotShown") }}</div>
      </template>
      <!-- single-file diff: structured tinted rows with dual line numbers (no syntax highlight) -->
      <template v-else-if="files.diffPath && files.diff">
        <div v-if="parsedDiff && parsedDiff.rows.length" data-test="fv-diff-body" class="font-mono text-[12.5px] leading-relaxed">
          <div v-for="(r, i) in parsedDiff.rows" :key="i" data-test="fv-diff-row" class="flex"
               :class="r.type === 'add' ? 'bg-run/10' : r.type === 'del' ? 'bg-danger/10' : r.type === 'hunk' ? 'bg-info/5' : ''">
            <span class="sticky left-0 w-12 shrink-0 select-none border-r border-border bg-surface px-2 text-right tabular-nums text-fg-muted/70">{{ r.oldNo ?? "" }}</span>
            <span class="w-12 shrink-0 select-none border-r border-border bg-surface px-2 text-right tabular-nums text-fg-muted/70">{{ r.newNo ?? "" }}</span>
            <span class="w-4 shrink-0 select-none text-center" :class="r.type === 'add' ? 'text-run' : r.type === 'del' ? 'text-danger' : 'text-fg-muted/40'">{{ r.type === 'add' ? '+' : r.type === 'del' ? '-' : '' }}</span>
            <span class="whitespace-pre px-2" :class="r.type === 'hunk' ? 'text-info' : 'text-fg'">{{ r.text }}</span>
          </div>
        </div>
        <div v-else class="p-6 text-sm text-fg-muted">{{ $t("files.noDiffContent") }}</div>
        <div v-if="files.diff.truncated" class="px-4 py-1 text-xs text-warn">{{ $t("files.diffTruncated") }}</div>
      </template>
    </div>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/fileviewer.test.ts`
Expected: PASS (all FileViewer tests, including the rewritten highlight + structured-diff tests).

- [ ] **Step 6: Full relay-web test + typecheck + build**

Run: `npx vitest run && bun run build`
Expected: all relay-web tests pass; `bun run build` (which runs `vue-tsc --noEmit` then `vite build`) reports no type errors and builds with Shiki in a lazy chunk (re-confirm it's not in the entry chunk).

- [ ] **Step 7: Commit**

```bash
git add packages/relay-web/src/components/FileViewer.vue packages/relay-web/src/__tests__/fileviewer.test.ts
git commit -m "feat(relay-web): Shiki-highlighted file viewer + structured diff rows"
```

---

## Final verification (after all tasks)

- [ ] **Core suite (per-file):** `bun test tests/unit/control/workspace-fs.test.ts` → green.
- [ ] **Core typecheck:** `npx tsc --noEmit` → clean.
- [ ] **relay-web suite:** `cd packages/relay-web && npx vitest run` → green.
- [ ] **Manual smoke (real relay):** non-ASCII filename shows raw in the list, clicking it shows a real diff (not "not found"); untracked file shows all-additions diff; a source file in the viewer is syntax-highlighted with line numbers in both light and dark mode; long paths show a full-path tooltip; the three groups collapse/expand and persist across reload.
- [ ] **CHANGELOG (English)** entry added when the release is cut (per existing version-coupling convention: `package.json` + `tests/unit/packages/package-metadata.test.ts` + `weacpx-compat`; relay-web ships with its owning package). Release itself is out of this plan's scope — flag for a separate release step.

## Notes / deliberate scope trims

- **No whole-file folding widget.** The dedicated FileViewer already scrolls and already drops to a plain `<pre>` above 5000 lines, so HAPI's CodeBlock collapse (designed for *inline* chat code blocks) adds little here. Omitted on purpose; revisit if/when inline code blocks land.
- **Diffs are not syntax-highlighted** (matches HAPI). Only the file viewer is.
- **No protocol/bridge/control-service changes** — verify none were needed at review time.
- **`/dev/null` in `git diff --no-index`** works on git-for-Windows too (git maps it); if a Windows edge case surfaces, the catch leaves `diff` empty (graceful, same as today).
