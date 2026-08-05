import { homedir } from "node:os";
import { join } from "node:path";

import { coreEnv } from "../runtime/core-env";
import { coreHomeDir } from "../runtime/core-home";

export function resolveConfigPathForCurrentEnv(): string {
  return coreEnv("CONFIG") ?? join(coreHomeDir(process.env.HOME ?? homedir()), "config.json");
}
