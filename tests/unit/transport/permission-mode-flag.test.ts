import { describe, expect, test } from "bun:test";

import { permissionModeToFlag } from "../../../src/transport/permission-mode-flag";

describe("permissionModeToFlag", () => {
  test("maps 'approve-reads' to '--approve-reads'", () => {
    expect(permissionModeToFlag("approve-reads")).toBe("--approve-reads");
  });

  test("maps 'deny-all' to '--deny-all'", () => {
    expect(permissionModeToFlag("deny-all")).toBe("--deny-all");
  });

  test("maps 'approve-all' to '--approve-all'", () => {
    expect(permissionModeToFlag("approve-all")).toBe("--approve-all");
  });
});