import type { ChannelCliProvider } from "./provider";
import { weixinCliProvider } from "./weixin-provider";

const cliProviders = new Map<string, ChannelCliProvider>();
let builtinProvidersRegistered = false;

export function registerChannelCliProvider(provider: ChannelCliProvider): void {
  const type = provider.type.trim();
  if (!type) throw new Error("channel CLI provider type must be non-empty");
  if (type.includes(":")) throw new Error("channel CLI provider type must not contain ':'");
  if (cliProviders.has(type)) {
    throw new Error(`channel CLI provider is already registered: ${type}`);
  }
  cliProviders.set(type, provider);
}

export function hasChannelCliProvider(type: string): boolean {
  bootstrapBuiltinChannelCliProviders();
  return cliProviders.has(type);
}

export function unregisterChannelCliProvider(type: string): void {
  cliProviders.delete(type.trim());
}

export function getRegisteredChannelCliProviderTypes(): string[] {
  bootstrapBuiltinChannelCliProviders();
  return Array.from(cliProviders.keys()).sort();
}

export function bootstrapBuiltinChannelCliProviders(): void {
  if (builtinProvidersRegistered) return;
  builtinProvidersRegistered = true;
  if (!cliProviders.has(weixinCliProvider.type)) registerChannelCliProvider(weixinCliProvider);
}

export function listChannelCliProviders(): ChannelCliProvider[] {
  bootstrapBuiltinChannelCliProviders();
  return Array.from(cliProviders.values());
}

export function getChannelCliProvider(type: string): ChannelCliProvider | null {
  bootstrapBuiltinChannelCliProviders();
  return cliProviders.get(type) ?? null;
}
