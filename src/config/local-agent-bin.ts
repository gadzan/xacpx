import { statSync } from "node:fs";
import { delimiter, join, win32 as win32Path } from "node:path";

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
  // reasonix (npm `reasonix`) and omp (npm `@oh-my-pi/cli`) speak ACP via
  // `<bin> acp` like opencode — not via a separate `@agentclientprotocol/*`
  // adapter package, so they don't show up in acpx's registry. We list them
  // here so a locally-installed CLI short-circuits acpx's npx fallback, and
  // the drift guard in agent-catalog.test.ts exempts them for the same
  // reason as hermes: xacpx itself supplies the command at runtime.
  reasonix: { bin: "reasonix", args: ["acp"] },
  omp: { bin: "omp", args: ["acp"] },
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
function defaultIsExecutableFile(p: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    return platform === "win32" || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a command to the executable file selected by PATH/PATHEXT. The
 * result is used only to distinguish Windows script launchers from real
 * executables; callers that need exact argv should continue to invoke the
 * original command when the result is an .exe/.com or otherwise direct.
 */
export function resolveExecutableOnPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isExecutableFile?: (path: string) => boolean,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (!pathValue) return undefined;

  const pathJoin = platform === "win32" ? win32Path.join : join;
  const pathEntries = pathValue.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const extensions = executableExtensions(platform, env);
  const basename = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const hasExtension = platform === "win32" && /\.[^\\/]+$/u.test(basename);
  const hasPath = /[\\/]/u.test(name) || (platform === "win32" && /^[A-Za-z]:/u.test(name));
  const fileCheck = isExecutableFile ?? ((path: string) => defaultIsExecutableFile(path, platform));

  for (const directory of hasPath ? [""] : pathEntries) {
    const base = hasPath ? name : pathJoin(directory, name);
    const candidates = hasExtension ? [base] : extensions.map((extension) => `${base}${extension}`);
    for (const candidate of candidates) {
      if (fileCheck(candidate)) return candidate;
    }
  }
  return undefined;
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
  return resolveExecutableOnPath(name, process.platform, env, isExecutableFile) !== undefined;
}

/**
 * Is `driver` listed as a local-fallback agent in LOCAL_AGENT_BINS? Use this — not a
 * hand-copied allow-list — for drift guards that need to exempt drivers xacpx itself
 * supplies at runtime (e.g. `agent-catalog.test.ts`'s acpx-registry drift guard).
 */
export function isLocalAgentBinDriver(driver: string): boolean {
  return Object.hasOwn(LOCAL_AGENT_BINS, driver);
}

/**
 * If `driver` is a known npx-fallback agent AND its native CLI is on PATH, return the
 * structured argv (e.g. `["opencode", "acp"]`); otherwise undefined (let acpx fall back
 * to its npx default). The bare bin name is resolved on PATH at spawn time, sidestepping
 * any path-with-spaces quoting concerns.
 */
export function resolveLocalAgentArgv(
  driver: string,
  onPath: (name: string) => boolean = (name) => isExecutableOnPath(name),
): string[] | undefined {
  const spec = LOCAL_AGENT_BINS[driver];
  if (!spec) return undefined;
  if (!onPath(spec.bin)) return undefined;
  return [spec.bin, ...spec.args];
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
  return resolveLocalAgentArgv(driver, onPath)?.join(" ");
}
