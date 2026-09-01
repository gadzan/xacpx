import { expect, test } from "bun:test";
import { buildXacpxSlashCommands } from "../../../../packages/channel-discord/src/discord-commands";

test("builds xacpx slash commands matching core aliases", () => {
  const cmds = buildXacpxSlashCommands();
  const names = cmds.map((c) => c.name);
  expect(names).toContain("help");
  expect(names).toContain("ss");
  expect(names).toContain("use");
  expect(names).toContain("cancel");
  expect(names).toContain("status");
  expect(names).toContain("sessions");
  const ss = cmds.find((c) => c.name === "ss")!;
  expect(ss.description.toLowerCase()).toContain("session");
  expect(ss.options?.some((o) => o.name === "agent")).toBe(true);
});

test("each command has name and description", () => {
  const cmds = buildXacpxSlashCommands();
  for (const cmd of cmds) {
    expect(cmd.name.length).toBeGreaterThan(0);
    expect(cmd.description.length).toBeGreaterThan(0);
    expect(cmd.name).toMatch(/^[a-z0-9_-]+$/);
  }
});
