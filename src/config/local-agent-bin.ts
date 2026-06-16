import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Drivers whose acpx default is an UNPINNED `npx -y <pkg> acp` — these re-resolve
 * "latest" from the npm registry on every cold start, so each one is a network
 * dependency (and a failure point: a blip yields "ACP agent exited before initialize").
 * When the agent's native CLI is already installed, prefer it: no npm, no network.
 *
 * Not listed (and intentionally so):
 *  - codex / claude: also npx, but version-PINNED and registered in acpx's
 *    BUILT_IN_AGENT_PACKAGES, so acpx already prefers an installed binary.
 *  - every other driver (gemini, cursor, droid, …) is already a native command.
 */
const LOCAL_AGENT_BINS: Record<string, { bin: string; args: string[] }> = {
  opencode: { bin: "opencode", args: ["acp"] },
  kilocode: { bin: "kilocode", args: ["acp"] },
};

/**
 * Executable-file extensions to try for a bare command name. POSIX: just the name;
 * Windows: the PATHEXT list (executability there is decided by extension, not a mode bit).
 */
export function executableExtensions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  return platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((e) => e.length > 0)
    : [""];
}

/**
 * Is `p` a regular file that's executable? POSIX requires an exec bit; on Windows any
 * regular file qualifies (PATHEXT already gated the extension). Rejecting directories
 * and non-exec files means a stray `opencode/` dir or a non-+x file on PATH can't
 * yield a false positive — which would spawn-fail, i.e. WORSE than the npx fallback.
 */
function defaultIsExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    return process.platform === "win32" || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Is `name` an executable on PATH? Cross-platform: honours PATHEXT on Windows so
 * `opencode` matches `opencode.cmd`/`.exe`. `env`/`isExecutableFile` are injectable for tests.
 */
export function isExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  isExecutableFile: (p: string) => boolean = defaultIsExecutableFile,
): boolean {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (!pathValue) return false;
  const exts = executableExtensions(process.platform, env);
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (isExecutableFile(join(dir, name + ext))) return true;
    }
  }
  return false;
}

/**
 * If `driver` is a known npx-fallback agent AND its native CLI is on PATH, return the
 * native command (e.g. `"opencode acp"`) to hand acpx via `--agent`; otherwise undefined
 * (let acpx fall back to its npx default). Returns the bare bin name — acpx resolves it
 * on PATH at spawn time, sidestepping any path-with-spaces quoting concerns.
 */
export function resolveLocalAgentCommand(
  driver: string,
  onPath: (name: string) => boolean = (name) => isExecutableOnPath(name),
): string | undefined {
  const spec = LOCAL_AGENT_BINS[driver];
  if (!spec) return undefined;
  if (!onPath(spec.bin)) return undefined;
  return [spec.bin, ...spec.args].join(" ");
}
