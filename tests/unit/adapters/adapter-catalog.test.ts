import { expect, test } from "bun:test";

import {
  buildManagedAdapterCommand,
  effectiveAdapterVersion,
  isExactAdapterVersion,
  isManagedAdapterCommand,
} from "../../../src/adapters/adapter-catalog";

test("managed adapters use tested exact defaults and accept local overrides", () => {
  expect(effectiveAdapterVersion("codex", {})).toBe("1.1.4");
  expect(effectiveAdapterVersion("claude", {})).toBe("0.59.0");
  expect(effectiveAdapterVersion("codex", { codex: "1.1.2" })).toBe("1.1.2");
  expect(buildManagedAdapterCommand("codex", "1.1.2")).toBe(
    "npx -y --registry=https://registry.npmjs.org/ --@agentclientprotocol:registry=https://registry.npmjs.org/ @agentclientprotocol/codex-acp@1.1.2",
  );
  expect(buildManagedAdapterCommand("codex", "1.1.2", "https://npm.corp.example/repository/npm/")).toBe(
    "npx -y --registry=https://npm.corp.example/repository/npm/ --@agentclientprotocol:registry=https://npm.corp.example/repository/npm/ @agentclientprotocol/codex-acp@1.1.2",
  );
});

test("adapter versions are exact semver values, never ranges or package specs", () => {
  expect(isExactAdapterVersion("1.1.4")).toBe(true);
  expect(isExactAdapterVersion("1.2.0-beta.1")).toBe(true);
  for (const value of [
    "latest",
    "^1.1.4",
    "1.x",
    "1.0.0-01",
    "1.0.0-beta.01",
    "github:user/repo",
    "1.1.4; rm -rf /",
  ]) {
    expect(isExactAdapterVersion(value)).toBe(false);
  }
});

test("recognizes only generated commands for managed adapter packages", () => {
  expect(isManagedAdapterCommand(
    "codex",
    "npx -y --registry=https://registry.npmjs.org/ --@agentclientprotocol:registry=https://registry.npmjs.org/ @agentclientprotocol/codex-acp@1.1.4",
  )).toBe(true);
  expect(isManagedAdapterCommand("codex", "npx -y @agentclientprotocol/codex-acp@1.1.4")).toBe(true);
  expect(isManagedAdapterCommand("codex", "npx -y @agentclientprotocol/codex-acp@^0.0.44")).toBe(true);
  expect(isManagedAdapterCommand("codex", "custom-codex-acp")).toBe(false);
  expect(isManagedAdapterCommand("claude", "npx -y @agentclientprotocol/codex-acp@1.1.4")).toBe(false);
});
