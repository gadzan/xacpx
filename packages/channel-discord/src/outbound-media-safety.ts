import fs from "node:fs/promises";
import path from "node:path";

export async function resolveSafeOutboundMediaPath(
  mediaPath: string,
  allowedRoots: string[],
): Promise<string | null> {
  if (mediaPath.startsWith("http://") || mediaPath.startsWith("https://")) {
    return null;
  }

  const candidate = path.isAbsolute(mediaPath) ? mediaPath : path.resolve(mediaPath);
  const realCandidate = await realpathOrNull(candidate);
  if (!realCandidate) {
    return null;
  }

  const stat = await fs.stat(realCandidate).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }

  for (const root of allowedRoots) {
    const realRoot = await realpathOrNull(root);
    if (realRoot && isPathInside(realCandidate, realRoot)) {
      return realCandidate;
    }
  }

  return null;
}

async function realpathOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
