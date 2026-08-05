import { createHash } from "node:crypto";

import type {
  AdapterTokenParams,
  BridgeOriginatedMethod,
  LaunchSettledParams,
  RegisterAdapterIntentParams,
  ResolveAdapterCommandParams,
} from "./acpx-bridge/acpx-bridge-protocol";
import type { OwnerFingerprint, OrphanRegistry } from "./orphan-registry";

type TokenState = "registering" | "registered" | "spawn-committed" | "canceled" | "owner-committed" | "launch-failed" | "aborted";

interface TokenEntry {
  state: TokenState;
  payload?: RegisterAdapterIntentParams;
  ack?: RegisterAck;
  registration?: Promise<RegisterAck>;
  cancelRequested?: boolean;
  terminalOutcome?: "owner-committed" | "launch-failed";
}

interface RegisterAck { agentCommand: string; intentToken: string; generationId: string }

export interface LaunchIntentCoordinatorDeps<TLocked = unknown> {
  platform?: NodeJS.Platform;
  runtimeRoot: string;
  configRoot: string;
  generationId: string;
  registry?: OrphanRegistry;
  classifyAdapter(command: string): "codex" | "claude" | null;
  resolveAdapter(command: string): Promise<string>;
  withSessionLock<T>(critical: (locked: TLocked) => Promise<T>): Promise<T>;
  withAdapterLock<T>(id: "codex" | "claude", critical: () => Promise<T>): Promise<T>;
  persistCommand(locked: TLocked, sessionKey: string, command: string): Promise<void>;
  queryLauncherIdentity(pid: number): Promise<{ creationDate: string } | null>;
  verifyOwner(pid: number, token: string): Promise<OwnerFingerprint | null>;
  snapshotToken(token: string): Promise<unknown[] | null>;
  now?: () => Date;
  onWarning?: (message: string, context?: Record<string, unknown>) => void;
}

export class LaunchIntentCoordinator<TLocked = unknown> {
  private readonly entries = new Map<string, TokenEntry>();

  constructor(private readonly deps: LaunchIntentCoordinatorDeps<TLocked>) {}

  async handle(
    method: BridgeOriginatedMethod,
    params: Record<string, unknown>,
    context: { launcherPid?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (method === "resolveAdapterCommand") return await this.resolveUnix(params as unknown as ResolveAdapterCommandParams);
    if ((this.deps.platform ?? process.platform) !== "win32") throw new Error(`${method} is Windows-only`);
    switch (method) {
      case "registerAdapterIntent":
        return await this.register(params as unknown as RegisterAdapterIntentParams, context);
      case "launcherSpawned":
        return await this.spawned(params as unknown as AdapterTokenParams);
      case "cancelAdapterIntent":
        return await this.cancel(params as unknown as AdapterTokenParams);
      case "launchSettled":
        return await this.settled(params as unknown as LaunchSettledParams);
    }
  }

  disconnect(): void {
    for (const entry of this.entries.values()) {
      if (entry.state === "registering") entry.state = "aborted";
      // registered/spawn-committed intentionally retain their durable intent.
    }
  }

  stateFor(params: AdapterTokenParams): TokenState | undefined {
    return this.entries.get(keyOf(params))?.state;
  }

  private async resolveUnix(params: ResolveAdapterCommandParams): Promise<{ agentCommand: string }> {
    if ((this.deps.platform ?? process.platform) === "win32") throw new Error("resolveAdapterCommand is Unix-only");
    const agentCommand = await this.durableResolve(params.sessionKey, params.agentCommand);
    return { agentCommand };
  }

  private async register(
    params: RegisterAdapterIntentParams,
    context: { launcherPid?: number; signal?: AbortSignal },
  ): Promise<RegisterAck> {
    const key = keyOf(params);
    const existing = this.entries.get(key);
    if (existing) {
      if (!samePayload(existing.payload, params)) throw new Error("registerAdapterIntent payload mismatch");
      if (existing.state === "registering" && existing.registration) return await existing.registration;
      if (existing.state === "registered" && existing.ack) return existing.ack;
      throw new Error(`registerAdapterIntent is invalid in ${existing.state}`);
    }
    if (!context.launcherPid) throw new Error("trusted bridge launcher pid is unavailable");
    const entry: TokenEntry = { state: "registering", payload: structuredClone(params) };
    this.entries.set(key, entry);
    const onAbort = () => { if (entry.state === "registering") entry.state = "aborted"; };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    entry.registration = this.performRegistration(entry, params, context.launcherPid)
      .finally(() => context.signal?.removeEventListener("abort", onAbort));
    try { return await entry.registration; }
    catch (error) {
      if (entry.state === "registering") entry.state = entry.cancelRequested ? "canceled" : "aborted";
      throw error;
    }
  }

  private async performRegistration(
    entry: TokenEntry,
    params: RegisterAdapterIntentParams,
    launcherPid: number,
  ): Promise<RegisterAck> {
    const id = this.deps.classifyAdapter(params.agentCommand);
    if (!id) throw new Error("agent command is not a managed preinstalled adapter");
    const launcher = await this.deps.queryLauncherIdentity(launcherPid);
    if (!launcher) throw new Error("trusted bridge launcher identity is unavailable");
    if (params.launcherPid !== launcherPid || params.launcherCreationDate !== launcher.creationDate) {
      this.deps.onWarning?.("bridge launcher identity report differed from daemon observation", {
        reportedPid: params.launcherPid,
        actualPid: launcherPid,
      });
    }
    const registry = this.requireRegistry();
    let finalCommand = "";
    await this.deps.withSessionLock(async (locked) => {
      finalCommand = await this.deps.withAdapterLock(id, async () => {
        const resolved = await this.deps.resolveAdapter(params.agentCommand);
        await this.deps.persistCommand(locked, params.sessionKey, resolved);
        if (entry.state === "aborted" || entry.cancelRequested) throw new Error("adapter registration aborted before intent write");
        await registry.writeIntent({
          schemaVersion: 1,
          kind: "intent",
          token: params.intentToken,
          launcherPid,
          launcherCreationDate: launcher.creationDate,
          generationId: this.deps.generationId,
          configRoot: this.deps.configRoot,
          queueHash: queueHash(params.sessionKey),
          agentCommand: resolved,
          createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
        });
        if (isAborted(entry) || entry.cancelRequested) {
          await registry.deleteIntent(params.intentToken);
          entry.state = entry.cancelRequested ? "canceled" : "aborted";
          throw new Error("adapter registration aborted after intent write");
        }
        entry.ack = { agentCommand: resolved, intentToken: params.intentToken, generationId: this.deps.generationId };
        entry.state = "registered";
        return resolved;
      });
    });
    return entry.ack ?? { agentCommand: finalCommand, intentToken: params.intentToken, generationId: this.deps.generationId };
  }

  private async spawned(params: AdapterTokenParams): Promise<Record<string, never>> {
    const entry = this.requireEntry(params);
    if (entry.state !== "registered") throw new Error(`launcherSpawned is invalid in ${entry.state}`);
    entry.state = "spawn-committed";
    return {};
  }

  private async cancel(params: AdapterTokenParams): Promise<Record<string, never>> {
    const key = keyOf(params);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: "canceled" };
      this.entries.set(key, entry);
      return {};
    }
    if (entry.state === "registering") {
      entry.cancelRequested = true;
      return {};
    }
    if (entry.state === "registered") {
      await this.requireRegistry().deleteIntent(params.intentToken);
      entry.state = "canceled";
      return {};
    }
    throw new Error(`cancelAdapterIntent is invalid in ${entry.state}`);
  }

  private async settled(params: LaunchSettledParams): Promise<Record<string, never>> {
    const entry = this.requireEntry(params);
    if ((entry.state === "owner-committed" || entry.state === "launch-failed")
      && entry.terminalOutcome === params.outcome) return {};
    if (entry.state !== "spawn-committed" || !entry.payload || !entry.ack) {
      throw new Error(`launchSettled is invalid in ${entry.state}`);
    }
    const registry = this.requireRegistry();
    if (params.outcome === "launch-failed") {
      const snapshot = await this.deps.snapshotToken(params.intentToken);
      if (snapshot === null || snapshot.length > 0) throw new Error("launch-failed token snapshot is unavailable or nonempty");
      await registry.deleteIntent(params.intentToken);
      entry.state = "launch-failed";
      entry.terminalOutcome = "launch-failed";
      return {};
    }
    if (!params.ownerPid || !params.ownerAcpxRecordId) throw new Error("owner settlement is incomplete");
    const fingerprint = await this.deps.verifyOwner(params.ownerPid, params.intentToken);
    if (!fingerprint) throw new Error("owner identity verification failed");
    await registry.migrateIntentToOwner(params.intentToken, {
      schemaVersion: 1,
      token: params.intentToken,
      pid: params.ownerPid,
      queueHash: queueHash(params.sessionKey),
      acpxRecordId: params.ownerAcpxRecordId,
      generationId: this.deps.generationId,
      configRoot: this.deps.configRoot,
      startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      agentCommand: entry.ack.agentCommand,
      fingerprint,
      killAttempts: 0,
    });
    entry.state = "owner-committed";
    entry.terminalOutcome = "owner-committed";
    return {};
  }

  private async durableResolve(sessionKey: string, command: string): Promise<string> {
    const id = this.deps.classifyAdapter(command);
    if (!id) throw new Error("agent command is not a managed preinstalled adapter");
    let finalCommand = "";
    await this.deps.withSessionLock(async (locked) => {
      finalCommand = await this.deps.withAdapterLock(id, async () => {
        const resolved = await this.deps.resolveAdapter(command);
        await this.deps.persistCommand(locked, sessionKey, resolved);
        return resolved;
      });
    });
    return finalCommand;
  }

  private requireEntry(params: AdapterTokenParams): TokenEntry {
    const entry = this.entries.get(keyOf(params));
    if (!entry) throw new Error("unknown adapter launch token");
    return entry;
  }

  private requireRegistry(): OrphanRegistry {
    if (!this.deps.registry) throw new Error("Windows orphan registry is unavailable");
    return this.deps.registry;
  }
}

function keyOf(params: AdapterTokenParams): string {
  return `${params.id}\0${params.sessionKey}\0${params.intentToken}`;
}

function samePayload(left: RegisterAdapterIntentParams | undefined, right: RegisterAdapterIntentParams): boolean {
  return left !== undefined
    && left.id === right.id
    && left.sessionKey === right.sessionKey
    && left.intentToken === right.intentToken
    && left.agentCommand === right.agentCommand
    && left.launcherPid === right.launcherPid
    && left.launcherCreationDate === right.launcherCreationDate;
}

function queueHash(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
}

function isAborted(entry: TokenEntry): boolean {
  return entry.state === "aborted";
}
