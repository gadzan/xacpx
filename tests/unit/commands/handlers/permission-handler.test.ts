import { expect, test, beforeEach } from "bun:test";
import {
  handlePermissionStatus,
  handlePermissionAutoStatus,
  renderPermissionStatus,
  permissionHelp,
} from "../../../../src/commands/handlers/permission-handler";
import { setLocale } from "../../../../src/i18n";

beforeEach(() => {
  setLocale("zh");
});

test("permissionHelp returns correct help metadata", () => {
  const help = permissionHelp();
  expect(help.topic).toBe("permission");
  expect(help.aliases).toContain("pm");
  expect(help.summary).toBeDefined();
  expect(help.commands.length).toBeGreaterThan(0);
});

test("handlePermissionStatus returns current permission status", () => {
  const context = {
    config: {
      transport: {
        permissionMode: "approve-reads",
        nonInteractivePermissions: "deny",
      },
    },
  } as any;

  const result = handlePermissionStatus(context);
  expect(result.text).toContain("approve-reads");
  expect(result.text).toContain("deny");
});

test("handlePermissionStatus uses default values when config is undefined", () => {
  const context = { config: undefined } as any;

  const result = handlePermissionStatus(context);
  expect(result.text).toContain("approve-all");
  expect(result.text).toContain("deny");
});

test("renderPermissionStatus formats permission status correctly", () => {
  const config = {
    transport: {
      permissionMode: "deny-all",
      nonInteractivePermissions: "approve",
    },
  };

  const result = renderPermissionStatus(config, "Test Title");
  expect(result).toContain("Test Title");
  expect(result).toContain("deny-all");
  expect(result).toContain("approve");
});

test("renderPermissionStatus uses defaults when config is undefined", () => {
  const result = renderPermissionStatus(undefined, "Test Title");
  expect(result).toContain("Test Title");
  expect(result).toContain("approve-all");
  expect(result).toContain("deny");
});

test("handlePermissionAutoStatus returns current auto permission status", () => {
  const context = {
    config: {
      transport: {
        permissionMode: "approve-all",
        nonInteractivePermissions: "approve",
      },
    },
  } as any;

  const result = handlePermissionAutoStatus(context);
  expect(result.text).toContain("approve");
});