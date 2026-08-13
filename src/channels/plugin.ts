import type { ChannelFactory } from "./create-channel.js";
import {
  bootstrapBuiltinChannelFactories,
  hasChannelFactory,
  registerChannelFactory,
} from "./create-channel.js";
import type { ChannelCliProvider } from "./cli/provider.js";
import {
  bootstrapBuiltinChannelCliProviders,
  hasChannelCliProvider,
  registerChannelCliProvider,
} from "./cli/registry.js";
import type { ChannelRuntimeConfig } from "../config/types.js";

export type ChannelRetireDaemonState = "running" | "stopped" | "indeterminate";

/** Context passed to a plugin `retireChannel` hook from `channel disable|rm`. */
export interface ChannelRetireContext {
  channel: ChannelRuntimeConfig;
  reason: "disabled" | "removed";
  print: (line: string) => void;
  getDaemonStatus: () => Promise<{ state: ChannelRetireDaemonState }>;
}

export type ChannelRetireHook = (ctx: ChannelRetireContext) => Promise<void>;

export interface ChannelPluginDefinition {
  /** Stable channel type used in channels[].type and chatKey prefix. */
  type: string;
  factory: ChannelFactory;
  cliProvider?: ChannelCliProvider;
  /**
   * Optional CLI lifecycle hook for `xacpx channel disable|rm`.
   * Invoked after plugins are loaded, via the per-type registry — core must
   * not import the plugin npm package to retire resources.
   */
  retireChannel?: ChannelRetireHook;
}

const retireHooks = new Map<string, ChannelRetireHook>();

export function registerChannelPlugin(plugin: ChannelPluginDefinition): void {
  bootstrapBuiltinChannelFactories();
  bootstrapBuiltinChannelCliProviders();

  const channelType = plugin.type.trim();
  if (channelType && hasChannelFactory(channelType)) {
    throw new Error(`channel type is already registered: ${channelType}`);
  }

  const cliProviderType = plugin.cliProvider?.type.trim();
  if (cliProviderType && hasChannelCliProvider(cliProviderType)) {
    throw new Error(`channel CLI provider is already registered: ${cliProviderType}`);
  }

  registerChannelFactory(plugin.type, plugin.factory);
  if (plugin.cliProvider) registerChannelCliProvider(plugin.cliProvider);
  if (plugin.retireChannel) retireHooks.set(channelType, plugin.retireChannel);
}

export function getChannelRetireHook(type: string): ChannelRetireHook | undefined {
  return retireHooks.get(type);
}

/** Dispatch `channel disable|rm` retirement to the loaded plugin for this type. */
export async function invokeChannelRetireHook(ctx: ChannelRetireContext): Promise<void> {
  const hook = retireHooks.get(ctx.channel.type);
  if (!hook) return;
  await hook(ctx);
}
