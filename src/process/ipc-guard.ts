import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export interface IpcGuard {
  release(): Promise<void>;
}

export interface IpcGuardKey {
  role: string;
  configRoot: string;
  resourceId?: string;
}

export interface AcquireIpcGuardOptions {
  /** False for diagnostic/read-only callers which must not create configRoot. */
  createConfigRoot?: boolean;
  platform?: NodeJS.Platform;
  /** Test seam for filesystem failures; production callers leave this unset. */
  fileSystem?: Pick<typeof import("node:fs/promises"), "mkdir" | "realpath">;
}

export class IpcGuardBusyError extends Error {
  readonly code = "IPC_GUARD_BUSY";

  constructor(readonly pipeName: string, options?: ErrorOptions) {
    super(`IPC guard is already held: ${pipeName}`, options);
    this.name = "IpcGuardBusyError";
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function normalizeCanonicalIpcPath(value: string, platform: NodeJS.Platform = process.platform): string {
  let normalized = value.replaceAll("\\", "/");
  if (platform === "win32") normalized = normalized.toLowerCase();
  const root = normalized.match(/^(?:[a-z]:)?\/$/i)?.[0];
  if (!root) normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

async function realpathThroughNearestAncestor(
  absolutePath: string,
  realpathPath: typeof realpath,
): Promise<string> {
  const missing: string[] = [];
  let cursor = absolutePath;
  while (true) {
    try {
      const ancestor = await realpathPath(cursor);
      return missing.reduceRight((current, component) => join(current, component), ancestor);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor || cursor === parse(cursor).root) throw error;
      missing.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

export async function canonicalizeIpcGuardConfigRoot(
  configRoot: string,
  options: Pick<AcquireIpcGuardOptions, "createConfigRoot" | "platform"> = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const fileSystem = options.fileSystem ?? { mkdir, realpath };
  const absolute = isAbsolute(configRoot) ? configRoot : resolve(configRoot);
  let canonical: string;
  if (options.createConfigRoot !== false) {
    await fileSystem.mkdir(absolute, { recursive: true });
    canonical = await fileSystem.realpath(absolute);
  } else {
    canonical = await realpathThroughNearestAncestor(absolute, fileSystem.realpath);
  }
  return normalizeCanonicalIpcPath(canonical, platform);
}

export async function buildIpcGuardPipeName(
  key: IpcGuardKey,
  options: AcquireIpcGuardOptions = {},
): Promise<string> {
  const canonicalRoot = await canonicalizeIpcGuardConfigRoot(key.configRoot, options);
  const canonicalKey = createHash("sha256")
    .update(canonicalRoot)
    .update("\0")
    .update(key.role)
    .update("\0")
    .update(key.resourceId ?? "")
    .digest("hex");
  return `\\\\.\\pipe\\xacpx-${canonicalKey.slice(0, 16)}`;
}

function listenExclusively(server: Server, pipeName: string): Promise<void> {
  return new Promise((resolveListening, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") {
        reject(new IpcGuardBusyError(pipeName, { cause: error }));
      } else {
        reject(error);
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListening();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(pipeName);
  });
}

export async function acquireIpcGuard(
  key: IpcGuardKey,
  options: AcquireIpcGuardOptions = {},
): Promise<IpcGuard> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("IPC guards are Windows-only");
  }
  const pipeName = await buildIpcGuardPipeName(key, options);
  const server = createServer();
  try {
    await listenExclusively(server, pipeName);
  } catch (error) {
    server.close();
    throw error;
  }

  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      releasePromise ??= new Promise<void>((resolveRelease, reject) => {
        server.close((error) => error ? reject(error) : resolveRelease());
      });
      return releasePromise;
    },
  };
}
