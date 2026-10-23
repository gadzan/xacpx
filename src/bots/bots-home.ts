import { homedir } from "node:os";
import { join } from "node:path";
import { coreHomeDir } from "../runtime/core-home.js";

export function resolveBotsHome(home = process.env.HOME ?? homedir()): string {
  return join(coreHomeDir(home), "bots");
}
