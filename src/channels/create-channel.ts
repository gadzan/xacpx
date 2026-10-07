import type { ChannelConfig, ChannelRuntimeConfig } from "../config/types.js";
import type { MessageChannelRuntime } from "./types.js";
import type { RuntimeMediaStore } from "./media-store.js";
import { WeixinChannel } from "./weixin-channel.js";
import { registerKnownChannelId } from "./channel-scope.js";
import { normalizeChannelType } from "./channel-type.js";
import { getMovedChannelInstallHint as getKnownMovedChannelInstallHint } from "../plugins/known-plugins.js";

export function getMovedChannelInstallHint(type: string): string | null {
  return getKnownMovedChannelInstallHint(type);
}

function unsupportedChannelError(type: string): Error {
  return new Error(getMovedChannelInstallHint(type) ?? `unsupported channel type: ${type}. If this is a plugin channel, run: xacpx plugin add <package> and restart xacpx.`);
}

export interface CreateChannelDeps {
  mediaStore?: RuntimeMediaStore;
  allowedMediaRoots?: string[];
}

export type ChannelFactory = (options: Record<string, unknown> | undefined, deps?: CreateChannelDeps) => MessageChannelRuntime;

const channelFactories = new Map<string, ChannelFactory>();
let builtinFactoriesRegistered = false;

export function registerChannelFactory(type: string, factory: ChannelFactory): void {
  const normalized = normalizeChannelType(type);
  if (channelFactories.has(normalized)) {
    throw new Error(`channel type is already registered: ${normalized}`);
  }
  channelFactories.set(normalized, factory);
  registerKnownChannelId(normalized);
}

export function hasChannelFactory(type: string): boolean {
  bootstrapBuiltinChannelFactories();
  return channelFactories.has(type);
}

export function getRegisteredChannelTypes(): string[] {
  bootstrapBuiltinChannelFactories();
  return Array.from(channelFactories.keys()).sort();
}

export function bootstrapBuiltinChannelFactories(): void {
  if (builtinFactoriesRegistered) return;
  builtinFactoriesRegistered = true;
  if (!channelFactories.has("weixin")) {
    registerChannelFactory("weixin", (_options, deps) => new WeixinChannel(deps?.mediaStore, deps?.allowedMediaRoots));
  }
}

export function createMessageChannel(type: string, config?: Partial<ChannelConfig>, deps?: CreateChannelDeps): MessageChannelRuntime {
  bootstrapBuiltinChannelFactories();
  const factory = channelFactories.get(type);
  if (!factory) {
    throw unsupportedChannelError(type);
  }
  return factory(config?.options, deps);
}

export function createMessageChannelFromRuntimeConfig(config: ChannelRuntimeConfig, deps?: CreateChannelDeps): MessageChannelRuntime {
  if (config.id !== config.type) {
    throw new Error(
      `channels.${config.id}.id must equal type "${config.type}". ` +
      `Multiple instances of the same channel type are not yet supported.`,
    );
  }
  bootstrapBuiltinChannelFactories();
  const factory = channelFactories.get(config.type);
  if (!factory) {
    throw unsupportedChannelError(config.type);
  }
  return factory(config.options, deps);
}

export function createMessageChannels(configs: ChannelRuntimeConfig[], deps?: CreateChannelDeps): MessageChannelRuntime[] {
  return configs.filter((config) => config.enabled).map((c) => createMessageChannelFromRuntimeConfig(c, deps));
}
