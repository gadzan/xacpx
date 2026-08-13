import type { ChannelRuntimeConfig } from "../../config/types";
import { t } from "../../i18n";

type DaemonState = "running" | "stopped" | "indeterminate";

export interface RetireRelayChannelFromCliInput {
  channel: ChannelRuntimeConfig;
  print: (line: string) => void;
  getDaemonStatus: () => Promise<{ state: DaemonState }>;
  /**
   * Test seam. Production dynamically imports `@ganglion/xacpx-channel-relay`
   * so core does not take a static plugin dependency.
   */
  retireImpl?: {
    retireRelayTerminals: (input: {
      registryDir: string;
      terminalConfig: unknown;
    }) => Promise<{ status: "idle" | "terminated" | "cleanup-pending" }>;
    defaultTerminalRegistryDir: () => string;
    parseRelayChannelConfig: (options: Record<string, unknown>) => { terminal: unknown };
  };
}

/**
 * Relay terminal retirement for `channel disable|rm`.
 *
 * A live daemon already owns the sidecar and `terminals.json`. Starting a
 * second production sidecar from the CLI cannot see those process-owned
 * sessions, so retirement is deferred until restart when the daemon is
 * running or indeterminate. One-shot cleanup runs only when the daemon is
 * stopped.
 */
export async function retireRelayChannelFromCli(
  input: RetireRelayChannelFromCliInput,
): Promise<void> {
  if (input.channel.type !== "relay") return;

  const status = await input.getDaemonStatus();
  if (status.state === "running" || status.state === "indeterminate") {
    input.print(t().channelCli.channelRetirementDeferredUntilRestart(input.channel.id));
    return;
  }

  const options = (input.channel.options ?? {}) as Record<string, unknown>;
  let registryDir: string;
  let result: { status: "idle" | "terminated" | "cleanup-pending" };

  if (input.retireImpl) {
    const parsed = input.retireImpl.parseRelayChannelConfig(options);
    registryDir = input.retireImpl.defaultTerminalRegistryDir();
    result = await input.retireImpl.retireRelayTerminals({
      registryDir,
      terminalConfig: parsed.terminal,
    });
  } else {
    const {
      retireRelayTerminals,
      defaultTerminalRegistryDir,
      parseRelayChannelConfig,
    } = await import("@ganglion/xacpx-channel-relay");
    const parsed = parseRelayChannelConfig(options);
    registryDir = defaultTerminalRegistryDir();
    result = await retireRelayTerminals({
      registryDir,
      terminalConfig: parsed.terminal,
    });
  }

  if (result.status === "cleanup-pending") {
    input.print(
      `relay terminal cleanup is still pending under ${registryDir}; registry/owner identity was kept for retry`,
    );
  }
}
