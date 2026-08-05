import type { BridgeOriginatedMethod } from "./acpx-bridge/acpx-bridge-protocol";
import type { QueueOwnerAdapterContext } from "./acpx-queue-owner-launcher";

export interface AdapterDaemonRequester {
  (method: BridgeOriginatedMethod, params: Record<string, unknown>): Promise<unknown>;
}

export function createQueueOwnerAdapterContext(input: {
  id: "codex" | "claude";
  sessionKey: string;
  agentCommand: string;
  platform?: NodeJS.Platform;
  launcherIdentity(): Promise<{ pid: number; creationDate: string }>;
  requestDaemon: AdapterDaemonRequester;
  readCurrentGeneration(): Promise<string | null>;
}): QueueOwnerAdapterContext {
  const platform = input.platform ?? process.platform;
  const tokenParams = (intentToken: string) => ({
    id: input.id,
    sessionKey: input.sessionKey,
    intentToken,
  });
  return {
    id: input.id,
    sessionKey: input.sessionKey,
    agentCommand: input.agentCommand,
    platform,
    async prepare(intentToken) {
      if (platform !== "win32") {
        const result = await input.requestDaemon("resolveAdapterCommand", {
          id: input.id,
          sessionKey: input.sessionKey,
          agentCommand: input.agentCommand,
        }) as { agentCommand?: unknown };
        if (!result || typeof result.agentCommand !== "string" || !result.agentCommand) {
          throw new Error("daemon returned an invalid adapter command");
        }
        return { agentCommand: result.agentCommand };
      }
      const launcher = await input.launcherIdentity();
      const result = await input.requestDaemon("registerAdapterIntent", {
        ...tokenParams(intentToken),
        agentCommand: input.agentCommand,
        launcherPid: launcher.pid,
        launcherCreationDate: launcher.creationDate,
      }) as { agentCommand?: unknown; generationId?: unknown; intentToken?: unknown };
      if (!result || typeof result.agentCommand !== "string" || !result.agentCommand
        || typeof result.generationId !== "string" || !result.generationId
        || result.intentToken !== intentToken) {
        throw new Error("daemon returned an invalid adapter registration ack");
      }
      return { agentCommand: result.agentCommand, generationId: result.generationId };
    },
    async isGenerationCurrent(generationId) {
      return await input.readCurrentGeneration() === generationId;
    },
    async spawned(intentToken) {
      await input.requestDaemon("launcherSpawned", tokenParams(intentToken));
    },
    async cancel(intentToken) {
      await input.requestDaemon("cancelAdapterIntent", tokenParams(intentToken));
    },
    async settle(settlement) {
      await input.requestDaemon("launchSettled", {
        ...tokenParams(settlement.intentToken),
        outcome: settlement.outcome,
        ...(settlement.ownerPid ? { ownerPid: settlement.ownerPid } : {}),
        ...(settlement.ownerAcpxRecordId ? { ownerAcpxRecordId: settlement.ownerAcpxRecordId } : {}),
      });
    },
  };
}
