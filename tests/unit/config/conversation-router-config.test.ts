import { expect, test } from "bun:test";

import { parseConfig } from "../../../src/config/load-config";

const raw = { transport: {}, agents: {}, workspaces: {} };

test("conversations.router stays off when the section is absent", () => {
  expect(parseConfig(raw).conversations).toBeUndefined();
});

test("conversations.router accepts an enabled command and auth variable", () => {
  const config = parseConfig({
    ...raw,
    conversations: { router: { enabled: true, command: "/usr/bin/router", authEnv: "ROUTER_TOKEN", ignored: true } },
  });
  expect(config.conversations).toEqual({
    router: { enabled: true, command: "/usr/bin/router", authEnv: "ROUTER_TOKEN" },
  });
});

test("conversations.router rejects a non-boolean enabled flag", () => {
  expect(() => parseConfig({ ...raw, conversations: { router: { enabled: "yes" } } })).toThrow(
    "conversations.router.enabled must be boolean",
  );
});
