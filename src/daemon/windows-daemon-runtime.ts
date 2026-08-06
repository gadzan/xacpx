import { dirname } from "node:path";

import {
  createDaemonIdentity,
  OrphanRegistry,
  type DaemonIdentity,
} from "../transport/orphan-registry";

interface InitializeWindowsDaemonRuntimeOptions {
  configPath: string;
  runtimeDir: string;
  platform?: NodeJS.Platform;
  createIdentity?: typeof createDaemonIdentity;
  createRegistry?: (runtimeDir: string) => OrphanRegistry;
}

export type WindowsDaemonRuntimeDeps = {
  daemonIdentity?: DaemonIdentity;
  orphanRegistry?: OrphanRegistry;
};

export async function initializeWindowsDaemonRuntime(
  options: InitializeWindowsDaemonRuntimeOptions,
): Promise<WindowsDaemonRuntimeDeps> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return {};

  const configRoot = dirname(options.configPath);
  const orphanRegistry = (options.createRegistry ?? ((runtimeDir) => new OrphanRegistry(runtimeDir)))(options.runtimeDir);
  await orphanRegistry.initialize();
  const daemonIdentity = await (options.createIdentity ?? createDaemonIdentity)({
    configRoot,
    platform: "win32",
  });
  await orphanRegistry.writeGeneration(daemonIdentity);
  return { daemonIdentity, orphanRegistry };
}
