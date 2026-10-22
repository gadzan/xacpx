import { describe, expect, test } from "vitest";
import { slugify, genAlias, uniqueName, workspaceNameFromPath } from "../lib/session-form";

describe("slugify", () => {
  test("lowercases and replaces non [a-z0-9-] runs with a single dash", () => {
    expect(slugify("My Cool_Workspace!")).toBe("my-cool-workspace");
    expect(slugify("  --Trim--  ")).toBe("trim");
  });

  test("keeps the ASCII part of a mixed CJK name", () => {
    expect(slugify("项目-API_v2")).toBe("api-v2");
  });

  test("returns an empty slug for blank input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

describe("genAlias", () => {
  test("joins workspace and agent", () => {
    expect(genAlias("backend", "codex")).toBe("backend-codex");
    expect(genAlias("My WS", "Codex")).toBe("my-ws-codex");
  });

  test("derives an opaque alias when workspace and agent carry no ASCII", () => {
    expect(genAlias("项目", "代理")).toBe("workspace-2c519d38");
  });

  test("keeps the ASCII agent name when only the workspace is CJK", () => {
    expect(genAlias("项目", "codex")).toBe("codex");
  });
});

describe("uniqueName", () => {
  test("returns base when free, else suffixes -2, -3", () => {
    expect(uniqueName("backend-codex", [])).toBe("backend-codex");
    expect(uniqueName("backend-codex", ["backend-codex"])).toBe("backend-codex-2");
    expect(uniqueName("backend-codex", ["backend-codex", "backend-codex-2"])).toBe("backend-codex-3");
  });
});

describe("workspaceNameFromPath", () => {
  test("uses the basename, slugified", () => {
    expect(workspaceNameFromPath("/tmp/demo-project")).toBe("demo-project");
    expect(workspaceNameFromPath("/Users/me/My App/")).toBe("my-app");
    expect(workspaceNameFromPath("C:\\\\work\\\\Repo One")).toBe("repo-one");
  });

  test("derives an opaque name for a CJK path segment", () => {
    expect(workspaceNameFromPath("/Users/me/项目/后台服务")).toBe("workspace-60b83561");
  });

  test("derives different opaque names for different CJK path segments", () => {
    expect(workspaceNameFromPath("/Users/me/项目/后台服务")).not.toBe(
      workspaceNameFromPath("/Users/me/项目/前端服务"),
    );
  });

  test("returns an empty name for a path without a segment", () => {
    expect(workspaceNameFromPath("/")).toBe("");
  });

  test("returns an empty name for a symbols-only path segment", () => {
    expect(workspaceNameFromPath("@@@")).toBe("");
    expect(workspaceNameFromPath("/tmp/!!! ###")).toBe("");
  });

  test("derives an opaque name for a CJK segment that also carries symbols", () => {
    expect(workspaceNameFromPath("/tmp/@项目@")).toMatch(/^workspace-[0-9a-f]{8}$/);
  });
});
