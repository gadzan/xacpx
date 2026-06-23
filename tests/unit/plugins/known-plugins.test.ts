import { expect, test, beforeEach, afterAll } from "bun:test";

import {
  findKnownPluginByChannel,
  getMovedChannelInstallHint,
  listKnownPlugins,
} from "../../../src/plugins/known-plugins";
import { setLocale } from "../../../src/i18n";

beforeEach(() => { setLocale("zh"); });
afterAll(() => { setLocale("en"); });

test("listKnownPlugins includes Feishu, Yuanbao, and the Relay connector", () => {
  const plugins = listKnownPlugins();
  const packageNames = plugins.map((plugin) => plugin.packageName);
  expect(packageNames).toContain("@ganglion/xacpx-channel-feishu");
  expect(packageNames).toContain("@ganglion/xacpx-channel-yuanbao");
  expect(packageNames).toContain("@ganglion/xacpx-channel-relay");
});

test("listKnownPlugins marks every entry as official", () => {
  for (const plugin of listKnownPlugins()) {
    expect(plugin.official).toBe(true);
  }
});

test("listKnownPlugins does not surface weixin as an installable plugin", () => {
  const plugins = listKnownPlugins();
  for (const plugin of plugins) {
    expect(plugin.channels).not.toContain("weixin");
    expect(plugin.packageName).not.toContain("weixin");
  }
});

test("listKnownPlugins returns a copy so callers cannot mutate the source", () => {
  const before = listKnownPlugins();
  before[0]!.channels.push("mutated");
  const after = listKnownPlugins();
  expect(after[0]!.channels).not.toContain("mutated");
});

test("findKnownPluginByChannel returns the matching first-party package", () => {
  expect(findKnownPluginByChannel("feishu")?.packageName).toBe("@ganglion/xacpx-channel-feishu");
  expect(findKnownPluginByChannel("yuanbao")?.packageName).toBe("@ganglion/xacpx-channel-yuanbao");
  expect(findKnownPluginByChannel("relay")?.packageName).toBe("@ganglion/xacpx-channel-relay");
});

test("findKnownPluginByChannel returns null for built-in or unknown channels", () => {
  expect(findKnownPluginByChannel("weixin")).toBeNull();
  expect(findKnownPluginByChannel("totally-unknown")).toBeNull();
});

test("getMovedChannelInstallHint returns the explicit install command for known channels", () => {
  expect(getMovedChannelInstallHint("feishu")).toBe(
    "频道 feishu 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-feishu",
  );
  expect(getMovedChannelInstallHint("yuanbao")).toBe(
    "频道 yuanbao 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-yuanbao",
  );
  expect(getMovedChannelInstallHint("relay")).toBe(
    "频道 relay 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-relay",
  );
});

test("getMovedChannelInstallHint returns null for unknown channel types", () => {
  expect(getMovedChannelInstallHint("weixin")).toBeNull();
  expect(getMovedChannelInstallHint("nope")).toBeNull();
});
