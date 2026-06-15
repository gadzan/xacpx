import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { readdir, realpath, stat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

export interface FsEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
}
export interface DirListing {
  workspace: string;
  path: string;
  entries: FsEntry[];
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
export interface SearchResult {
  workspace: string;
  query: string;
  matches: string[];
  truncated: boolean;
}
export interface WorkspaceDiff {
  workspace: string;
  files: DiffFile[];
  diff: string;
  truncated: boolean;
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

  async listDirectory(workspace: string, relPath?: string): Promise<DirListing> {
    const { abs, rel } = await this.resolve(workspace, relPath);
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
    return { workspace, path: rel, entries };
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

  /** Find files whose relative path contains `query` (case-insensitive). Walks the
   *  tree breadth-first, skipping `.git`/`node_modules` and never following symlinks
   *  (so it stays contained), bounded by a scan budget and a result cap. */
  async search(workspace: string, query: string): Promise<SearchResult> {
    const { root } = await this.resolve(workspace, undefined);
    const needle = query.trim().toLowerCase();
    const matches: string[] = [];
    if (!needle) return { workspace, query, matches, truncated: false };

    let scanned = 0;
    let truncated = false;
    const queue: string[] = [root];
    while (queue.length) {
      const dir = queue.shift()!;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (++scanned > SEARCH_MAX_SCAN) { truncated = true; break; }
        if (d.isSymbolicLink()) continue; // never follow symlinks — keeps us contained
        if (d.isDirectory()) {
          if (!SEARCH_SKIP_DIRS.has(d.name)) queue.push(resolve(dir, d.name));
        } else if (d.isFile()) {
          const rel = relative(root, resolve(dir, d.name)).split(sep).join("/");
          if (rel.toLowerCase().includes(needle)) {
            matches.push(rel);
            if (matches.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
          }
        }
      }
      if (truncated) break;
    }
    matches.sort();
    return { workspace, query, matches, truncated };
  }

  async gitDiff(workspace: string, relPath?: string): Promise<WorkspaceDiff> {
    const { root, rel } = await this.resolve(workspace, relPath);
    try {
      await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { maxBuffer: GIT_MAX_BUFFER });
    } catch {
      throw new Error("not-a-git-repo");
    }

    // Changed-file list (includes untracked as "??").
    const files: DiffFile[] = [];
    try {
      const { stdout } = await execFileAsync("git", ["-C", root, "status", "--porcelain"], { maxBuffer: GIT_MAX_BUFFER });
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        const status = line.slice(0, 2);
        let path = line.slice(3);
        const arrow = path.indexOf(" -> "); // renamed: "old -> new"
        if (arrow >= 0) path = path.slice(arrow + 4);
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
    const truncated = diff.length > DIFF_CAP;
    return { workspace, files, diff: truncated ? diff.slice(0, DIFF_CAP) : diff, truncated };
  }
}
