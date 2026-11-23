import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of the built dashboard, or undefined when `dist/index.html` is absent. */
export function tryResolveWebRoot(moduleUrl = import.meta.url) {
  const dir = join(dirname(fileURLToPath(moduleUrl)), "dist");
  return existsSync(join(dir, "index.html")) ? dir : undefined;
}

/** Directory of the built dashboard. Throws when the package was published without `dist/`. */
export function resolveWebRoot(moduleUrl = import.meta.url) {
  const dir = tryResolveWebRoot(moduleUrl);
  if (!dir) {
    throw new Error("@ganglion/xacpx-web: built assets missing (expected dist/index.html next to this module)");
  }
  return dir;
}
