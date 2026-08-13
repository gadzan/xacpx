import { getLocale, type ChannelRetireContext } from "xacpx/plugin-api";

import { defaultTerminalRegistryDir } from "./channel.js";
import { parseRelayChannelConfig } from "./config.js";
import { retireRelayTerminals } from "./terminal/retire-terminals.js";

export interface RetireRelayChannelCliDeps {
  retireRelayTerminals?: typeof retireRelayTerminals;
  defaultTerminalRegistryDir?: () => string;
  parseRelayChannelConfig?: typeof parseRelayChannelConfig;
}

/**
 * Relay `channel disable|rm` retirement.
 *
 * A live daemon already owns the sidecar and `terminals.json`. Starting a
 * second production sidecar from the CLI cannot see those process-owned
 * sessions, so retirement is deferred until restart when the daemon is
 * running or indeterminate. One-shot cleanup runs only when the daemon is
 * stopped.
 */
export async function retireRelayChannelFromCli(
  ctx: ChannelRetireContext,
  deps: RetireRelayChannelCliDeps = {},
): Promise<void> {
  if (ctx.channel.type !== "relay") return;

  const status = await ctx.getDaemonStatus();
  if (status.state === "running" || status.state === "indeterminate") {
    ctx.print(deferredUntilRestartMessage(ctx.channel.id));
    return;
  }

  const parseConfig = deps.parseRelayChannelConfig ?? parseRelayChannelConfig;
  const registryDir = (deps.defaultTerminalRegistryDir ?? defaultTerminalRegistryDir)();
  const retire = deps.retireRelayTerminals ?? retireRelayTerminals;
  const parsed = parseConfig((ctx.channel.options ?? {}) as Record<string, unknown>);
  const result = await retire({
    registryDir,
    terminalConfig: parsed.terminal,
  });

  if (result.status === "cleanup-pending") {
    ctx.print(
      getLocale() === "zh"
        ? `relay 终端清理仍在 ${registryDir} 下待重试；已保留 registry/owner 身份`
        : `relay terminal cleanup is still pending under ${registryDir}; registry/owner identity was kept for retry`,
    );
  }
}

function deferredUntilRestartMessage(id: string): string {
  return getLocale() === "zh"
    ? `频道 ${id} 的终端退役已推迟到守护进程重启（当前 sidecar 仍持有会话）`
    : `Channel ${id} terminal retirement deferred until daemon restart (live sidecar still owns the shells)`;
}
