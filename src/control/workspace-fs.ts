import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { readdir, realpath, stat, open, readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

/** Expand a leading `~` to the home directory (workspace cwds are often configured
 *  as `~` or `~/path`). */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~" + sep)) return resolve(homedir(), p.slice(2));
  return p;
}

// Read-only browser over a configured workspace's files + git diff, for the relay
// web dashboard. Security model (deliberately the OPPOSITE of HAPI's fail-open one):
//   - default-deny: an unknown workspace name is rejected, never an absolute path.
//   - realpath containment: the target is symlink-resolved and must stay inside the
//     symlink-resolved workspace root, so neither `..` nor a symlink can escape.
//   - read-only: no method writes; git runs read-only subcommands via execFile
//     (argument array, never a shell) so a path cannot inject a command.
//   - bounded: entry counts, file size, and diff size are all capped.

const MAX_ENTRIES = 2000;
const FILE_READ_CAP = 256 * 1024; // 256 KiB
const DIFF_CAP = 512 * 1024; // 512 KiB
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_SCAN = 20000; // directory entries visited before giving up
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules"]);
const SEARCH_CONTENT_MAX_HITS = 500;
const SEARCH_CONTENT_MAX_FILE = 1024 * 1024; // skip files > 1 MiB in the fallback walker

export interface FsEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
  /** True when git check-ignore matches this entry (omitted in non-git workspaces). */
  ignored?: boolean;
}
export interface DirListing {
  workspace: string;
  path: string;
  entries: FsEntry[];
  /** Absolute realpath'd workspace root on the connector host. */
  root: string;
  /** Host path separator, so the client can render an absolute host path. */
  sep: "/" | "\\";
}
export interface FileContent {
  workspace: string;
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}
export interface DiffFile {
  path: string;
  status: string;
}
export interface SearchHit {
  path: string;
  line: number;
  text: string;
}
export interface SearchResult {
  workspace: string;
  query: string;
  matches: string[];
  hits: SearchHit[];
  truncated: boolean;
}
export interface SearchOptions {
  query: string;
  mode?: "name" | "content";
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Glob to restrict matches (relative to workspace root). */
  include?: string;
  /** Glob to drop matches. */
  exclude?: string;
  /** Base directory (relative) to scope the search; defaults to the whole workspace. */
  path?: string;
}
export interface WorkspaceDiff {
  workspace: string;
  files: DiffFile[];
  diff: string;
  truncated: boolean;
  /** Symbolic branch name (abbrev-ref HEAD); omitted when HEAD is detached. */
  branch?: string;
  /** True when HEAD is detached (no branch). */
  detached?: boolean;
  /** Working-tree context: its top-level root, and whether it's a linked (non-primary) worktree. */
  worktree?: { root: string; linked: boolean };
}

export interface WorkspaceRef {
  name: string;
  cwd: string;
}

export class WorkspaceFs {
  constructor(private readonly listWorkspaces: () => WorkspaceRef[]) {}

  /** Resolve `relPath` within a named workspace, symlink-safe and contained. Throws
   *  on unknown workspace, missing target, or any path that escapes the root. */
  private async resolve(workspace: string, relPath: string | undefined): Promise<{ root: string; abs: string; rel: string }> {
    const ref = this.listWorkspaces().find((w) => w.name === workspace);
    if (!ref) throw new Error("unknown-workspace");
    if (relPath && isAbsolute(relPath)) throw new Error("path-must-be-relative");

    let root: string;
    try {
      root = await realpath(expandHome(ref.cwd));
    } catch {
      throw new Error("workspace-root-missing");
    }
    const requested = resolve(root, relPath ?? ".");
    let abs: string;
    try {
      abs = await realpath(requested);
    } catch {
      throw new Error("not-found");
    }
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error("path-escapes-workspace");
    const rel = abs === root ? "" : relative(root, abs).split(sep).join("/");
    return { root, abs, rel };
  }

  /** Resolve the PARENT directory of a to-be-created/renamed target. Parent must exist
   *  and be contained; the final segment is validated (non-empty, no separators, not
   *  "."/".."). Because parent is realpath'd+contained and name has no separator, the
   *  join target stays inside the workspace root. */
  private async resolveParent(
    workspace: string,
    relPath: string,
  ): Promise<{ root: string; parentAbs: string; name: string; targetAbs: string; rel: string }> {
    if (relPath && isAbsolute(relPath)) throw new Error("path-must-be-relative");
    const trimmed = (relPath ?? "").replace(/\/+$/, "");
    if (!trimmed) throw new Error("bad-target"); // cannot create at/above the root
    const name = basename(trimmed);
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error("bad-target");
    }
    const parentRel = dirname(trimmed);
    // Resolve the parent through the existing choke point (realpath + containment).
    const { root, abs: parentAbs, rel: parentRelNorm } = await this.resolve(
      workspace,
      parentRel === "." ? undefined : parentRel,
    );
    const targetAbs = resolve(parentAbs, name);
    const rel = (parentRelNorm ? `${parentRelNorm}/${name}` : name);
    return { root, parentAbs, name, targetAbs, rel };
  }

  async createFile(workspace: string, relPath: string): Promise<{ path: string }> {
    const { targetAbs, rel } = await this.resolveParent(workspace, relPath);
    try {
      await writeFile(targetAbs, "", { flag: "wx" });
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") throw new Error("already-exists");
      throw e;
    }
    return { path: rel };
  }

  async createDir(workspace: string, relPath: string): Promise<{ path: string }> {
    const { targetAbs, rel } = await this.resolveParent(workspace, relPath);
    try {
      await mkdir(targetAbs);
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") throw new Error("already-exists");
      throw e;
    }
    return { path: rel };
  }

  async listDirectory(workspace: string, relPath?: string): Promise<DirListing> {
    const { root, abs, rel } = await this.resolve(workspace, relPath);
    const dirents = await readdir(abs, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const d of dirents.slice(0, MAX_ENTRIES)) {
      if (d.isDirectory()) {
        entries.push({ name: d.name, type: "dir" });
      } else if (d.isFile()) {
        let size: number | undefined;
        try {
          size = (await stat(resolve(abs, d.name))).size;
        } catch {
          size = undefined;
        }
        entries.push({ name: d.name, type: "file", size });
      }
      // symlinks / sockets / devices are skipped (not browsable read targets)
    }
    entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    // Mark gitignored entries (dirs are checked with a trailing slash so `dist/` rules match).
    const relOf = (name: string, isDir: boolean) => (rel ? `${rel}/${name}` : name) + (isDir ? "/" : "");
    const ignoredSet = await this.gitCheckIgnore(root, entries.map((e) => relOf(e.name, e.type === "dir")));
    for (const e of entries) {
      if (ignoredSet.has(relOf(e.name, e.type === "dir"))) e.ignored = true;
    }
    return { workspace, path: rel, entries, root, sep: sep as "/" | "\\" };
  }

  /** Return the subset of the given root-relative paths that git considers ignored.
   *  Uses `check-ignore -z --stdin` (bounded by the caller's MAX_ENTRIES listing).
   *  Any git error (not a repo, git missing) yields an empty set — callers degrade to
   *  "nothing ignored". Never throws. */
  private gitCheckIgnore(root: string, relPaths: string[]): Promise<Set<string>> {
    return new Promise((resolvePromise) => {
      if (!relPaths.length) return resolvePromise(new Set());
      const ignored = new Set<string>();
      let out = "";
      let child;
      try {
        child = spawn("git", ["-C", root, "check-ignore", "-z", "--stdin"], { stdio: ["pipe", "pipe", "ignore"] });
      } catch {
        return resolvePromise(ignored);
      }
      child.on("error", () => resolvePromise(ignored)); // git missing
      child.stdout.on("data", (b) => { out += b.toString(); });
      child.on("close", () => {
        for (const p of out.split("\0")) { if (p) ignored.add(p); }
        resolvePromise(ignored);
      });
      child.stdin.on("error", () => {}); // ignore EPIPE if git bails early
      child.stdin.end(relPaths.join("\0") + "\0");
    });
  }

  async readFile(workspace: string, relPath: string): Promise<FileContent> {
    const { abs, rel } = await this.resolve(workspace, relPath);
    const info = await stat(abs);
    if (!info.isFile()) throw new Error("not-a-file");
    const fh = await open(abs, "r");
    try {
      const buf = Buffer.alloc(Math.min(info.size, FILE_READ_CAP));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const slice = buf.subarray(0, bytesRead);
      const binary = slice.includes(0); // NUL byte ⇒ treat as binary
      return {
        workspace,
        path: rel,
        content: binary ? "" : slice.toString("utf8"),
        size: info.size,
        truncated: info.size > FILE_READ_CAP,
        binary,
      };
    } finally {
      await fh.close();
    }
  }

  /** Find files by name (default) or content. Name mode walks relative paths
   *  breadth-first, skipping `.git`/`node_modules` and never following symlinks (so it
   *  stays contained), applying the query plus any include/exclude globs. Content mode
   *  delegates to `contentGrep`. Both are bounded by a scan budget and a result cap. */
  async search(workspace: string, opts: SearchOptions): Promise<SearchResult> {
    const { root, abs: base, rel: scopeRel } = await this.resolve(workspace, opts.path);
    const query = opts.query.trim();
    const empty: SearchResult = { workspace, query, matches: [], hits: [], truncated: false };
    if (!query) return empty;

    if ((opts.mode ?? "name") === "content") {
      return this.contentGrep(workspace, root, base, scopeRel, opts, query);
    }

    // name mode: walk relative paths, apply matcher + include/exclude globs.
    const matcher = buildMatcher(query, opts);
    const inc = opts.include ? globToRegExp(opts.include) : null;
    const exc = opts.exclude ? globToRegExp(opts.exclude) : null;
    const matches: string[] = [];
    let scanned = 0;
    let truncated = false;
    const queue: string[] = [base];
    while (queue.length) {
      const dir = queue.shift()!;
      let dirents;
      try { dirents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of dirents) {
        if (++scanned > SEARCH_MAX_SCAN) { truncated = true; break; }
        if (d.isSymbolicLink()) continue; // never follow symlinks — keeps us contained
        if (d.isDirectory()) {
          if (!SEARCH_SKIP_DIRS.has(d.name)) queue.push(resolve(dir, d.name));
        } else if (d.isFile()) {
          const rel = relative(root, resolve(dir, d.name)).split(sep).join("/");
          if (inc && !inc.test(rel)) continue;
          if (exc && exc.test(rel)) continue;
          if (matcher(rel)) {
            matches.push(rel);
            if (matches.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
          }
        }
      }
      if (truncated) break;
    }
    matches.sort();
    return { workspace, query, matches, hits: [], truncated };
  }

  /** Content grep: `git grep` when the workspace root is a git repo (fast, respects
   *  .gitignore), else a bounded manual walk that scans each file line by line. Never
   *  throws on git absence/failure or an invalid user regex — both degrade gracefully.
   *  `scopeRel` is the already-resolved (canonicalized, containment-checked) scope from
   *  `resolve()`; include/exclude are applied as a post-filter on the parsed hits rather
   *  than as extra git pathspecs — git ORs multiple positive pathspecs together, so a
   *  scope pathspec plus an include pathspec would leak matches from outside the scope. */
  private async contentGrep(workspace: string, root: string, base: string, scopeRel: string, opts: SearchOptions, query: string): Promise<SearchResult> {
    const inc = opts.include ? globToRegExp(opts.include) : null;
    const exc = opts.exclude ? globToRegExp(opts.exclude) : null;

    // Try git grep first: it's fast and respects .gitignore. Args are argv (never a shell).
    const inGit = await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { maxBuffer: GIT_MAX_BUFFER })
      .then(() => true).catch(() => false);
    if (inGit) {
      const args = ["-C", root, "grep", "-n", "--column", "-I", "--no-color", "--untracked"];
      if (!opts.matchCase) args.push("-i");
      if (opts.wholeWord) args.push("-w");
      args.push(opts.regex ? "-E" : "-F");
      args.push("-e", query, "--", scopeRel || ".");
      let stdout = "";
      try {
        stdout = (await execFileAsync("git", args, { maxBuffer: GIT_MAX_BUFFER })).stdout;
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code === 1) stdout = ""; // no matches
        else { const out = (e as { stdout?: string }).stdout; stdout = typeof out === "string" ? out : ""; }
      }
      const hits: SearchHit[] = [];
      let truncated = false;
      for (const raw of stdout.split("\n")) {
        if (!raw) continue;
        // format: <path>:<line>:<column>:<text>
        const m = raw.match(/^(.*?):(\d+):(\d+):(.*)$/);
        if (!m) continue;
        const p = m[1]!.split(sep).join("/");
        if (inc && !inc.test(p)) continue;
        if (exc && exc.test(p)) continue;
        hits.push({ path: p, line: Number(m[2]), text: m[4]!.slice(0, 400) });
        if (hits.length >= SEARCH_CONTENT_MAX_HITS) { truncated = true; break; }
      }
      return { workspace, query, matches: [], hits, truncated };
    }

    // Fallback (non-git): bounded manual walk + per-line match.
    const matcher = buildLineMatcher(query, opts);
    const hits: SearchHit[] = [];
    let scanned = 0;
    let truncated = false;
    const queue: string[] = [base];
    while (queue.length) {
      const dir = queue.shift()!;
      let dirents;
      try { dirents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of dirents) {
        if (++scanned > SEARCH_MAX_SCAN) { truncated = true; break; }
        if (d.isSymbolicLink()) continue;
        const full = resolve(dir, d.name);
        if (d.isDirectory()) { if (!SEARCH_SKIP_DIRS.has(d.name)) queue.push(full); continue; }
        if (!d.isFile()) continue;
        const rel = relative(root, full).split(sep).join("/");
        if (inc && !inc.test(rel)) continue;
        if (exc && exc.test(rel)) continue;
        let info; try { info = await stat(full); } catch { continue; }
        if (info.size > SEARCH_CONTENT_MAX_FILE) continue;
        let text; try { text = await readFile(full, "utf8"); } catch { continue; }
        if (text.includes("\0")) continue; // NUL byte ⇒ binary, skip
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (matcher(line)) {
            hits.push({ path: rel, line: i + 1, text: line.slice(0, 400) });
            if (hits.length >= SEARCH_CONTENT_MAX_HITS) { truncated = true; break; }
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    return { workspace, query, matches: [], hits, truncated };
  }

  async gitDiff(workspace: string, relPath?: string): Promise<WorkspaceDiff> {
    const { root, rel } = await this.resolve(workspace, relPath);
    try {
      await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { maxBuffer: GIT_MAX_BUFFER });
    } catch {
      throw new Error("not-a-git-repo");
    }

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

    // Unified diff vs HEAD (staged + unstaged for tracked files). Fall back to a
    // working-tree diff in a fresh repo with no commit yet.
    const diffArgs = (base: string[]) => ["-C", root, ...base, ...(rel ? ["--", rel] : [])];
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

    const truncated = diff.length > DIFF_CAP;
    return { workspace, files, diff: truncated ? diff.slice(0, DIFF_CAP) : diff, truncated, ...(await this.gitContext(root)) };
  }

  /** Branch + worktree context for a repo root. Best-effort: any git hiccup just
   *  omits the fields so the diff itself still returns. */
  private async gitContext(root: string): Promise<Pick<WorkspaceDiff, "branch" | "detached" | "worktree">> {
    const run = async (...args: string[]): Promise<string | null> => {
      try {
        return (await execFileAsync("git", ["-C", root, ...args], { maxBuffer: GIT_MAX_BUFFER })).stdout.trim();
      } catch {
        return null;
      }
    };
    const ctx: Pick<WorkspaceDiff, "branch" | "detached" | "worktree"> = {};
    const head = await run("rev-parse", "--abbrev-ref", "HEAD");
    if (head === "HEAD") ctx.detached = true;
    else if (head) ctx.branch = head;

    const top = await run("rev-parse", "--show-toplevel");
    if (top) {
      // A linked worktree's per-worktree git dir differs from the repo's common dir
      // (e.g. <main>/.git/worktrees/<name> vs <main>/.git). The primary checkout has them equal.
      const gitDir = await run("rev-parse", "--absolute-git-dir");
      const commonDir = await run("rev-parse", "--path-format=absolute", "--git-common-dir");
      ctx.worktree = { root: top, linked: !!gitDir && !!commonDir && gitDir !== commonDir };
    }
    return ctx;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Build a path/name matcher for name-mode search. */
function buildMatcher(query: string, opts: SearchOptions): (s: string) => boolean {
  return buildLineMatcher(query, opts);
}
/** Build a per-line/string matcher honoring regex/wholeWord/matchCase. In non-regex
 *  mode it's a substring test; wholeWord wraps with \b boundaries. */
function buildLineMatcher(query: string, opts: SearchOptions): (s: string) => boolean {
  const flags = opts.matchCase ? "" : "i";
  let pattern: string;
  if (opts.regex) pattern = query;
  else pattern = escapeRe(query);
  if (opts.wholeWord) pattern = `\\b${pattern}\\b`;
  let re: RegExp | null = null;
  try { re = new RegExp(pattern, flags); } catch { re = null; }
  if (!re) {
    // Invalid user regex → fall back to case-adjusted substring so search never throws.
    const needle = opts.matchCase ? query : query.toLowerCase();
    return (s) => (opts.matchCase ? s : s.toLowerCase()).includes(needle);
  }
  return (s) => re!.test(s);
}
/** Minimal glob → RegExp for include/exclude (supports **, *, ?). Anchored full-match. */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escapeRe(c!);
  }
  re += "$";
  try { return new RegExp(re); } catch { return /$^/; }
}
