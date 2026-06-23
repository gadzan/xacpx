import { t } from "../i18n/index.js";

export interface KnownPlugin {
  packageName: string;
  channels: string[];
  description: string;
  official: true;
}

type KnownPluginTemplate = Omit<KnownPlugin, "description"> & { descriptionKey: keyof ReturnType<typeof t>["misc"] };

const KNOWN_PLUGIN_TEMPLATES: ReadonlyArray<KnownPluginTemplate> = [
  {
    packageName: "@ganglion/xacpx-channel-feishu",
    channels: ["feishu"],
    descriptionKey: "pluginChannelFeishu",
    official: true,
  },
  {
    packageName: "@ganglion/xacpx-channel-yuanbao",
    channels: ["yuanbao"],
    descriptionKey: "pluginChannelYuanbao",
    official: true,
  },
  {
    packageName: "@ganglion/xacpx-channel-relay",
    channels: ["relay"],
    descriptionKey: "pluginChannelRelay",
    official: true,
  },
];

function resolveDescription(key: keyof ReturnType<typeof t>["misc"]): string {
  const val = t().misc[key];
  return typeof val === "string" ? val : key;
}

export function listKnownPlugins(): KnownPlugin[] {
  return KNOWN_PLUGIN_TEMPLATES.map((plugin) => ({
    packageName: plugin.packageName,
    channels: [...plugin.channels],
    description: resolveDescription(plugin.descriptionKey),
    official: plugin.official,
  }));
}

export function findKnownPluginByChannel(channelType: string): KnownPlugin | null {
  const match = KNOWN_PLUGIN_TEMPLATES.find((plugin) => plugin.channels.includes(channelType));
  if (!match) return null;
  return {
    packageName: match.packageName,
    channels: [...match.channels],
    description: resolveDescription(match.descriptionKey),
    official: match.official,
  };
}

export function getMovedChannelInstallHint(channelType: string): string | null {
  const plugin = findKnownPluginByChannel(channelType);
  return plugin ? t().misc.pluginChannelInstallHint(channelType, plugin.packageName) : null;
}
