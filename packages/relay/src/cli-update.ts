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
