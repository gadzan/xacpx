import { afterEach, describe, expect, it } from "vitest";
import {
  loadGroupMode,
  saveGroupMode,
  groupSessions,
  dedupedSessionName,
  sessionPresentationName,
  shortestUniqueSuffix,
  archivedLast,
} from "../lib/sidebar-group-mode";

const KEY = "xacpx.sidebar.groupMode.i1";

describe("group mode persistence", () => {
  afterEach(() => localStorage.clear());

  it("defaults to instance (flat) when nothing is stored", () => {
    expect(loadGroupMode("i1")).toBe("instance");
  });

  it("round-trips workspace/agent through localStorage per instance", () => {
    saveGroupMode("i1", "workspace");
    expect(loadGroupMode("i1")).toBe("workspace");
    expect(loadGroupMode("other")).toBe("instance"); // isolated per instance
    saveGroupMode("i1", "agent");
    expect(loadGroupMode("i1")).toBe("agent");
  });

  it("removes the key when reset to instance", () => {
    saveGroupMode("i1", "workspace");
    saveGroupMode("i1", "instance");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadGroupMode("i1")).toBe("instance");
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem(KEY, "banana");
    expect(loadGroupMode("i1")).toBe("instance");
  });
});

const s = (
  alias: string,
  workspace: string,
  agent: string,
  archived = false,
) => ({ alias, workspace, agent, archived });

describe("groupSessions", () => {
  it("groups by workspace in first-appearance order, derived from sessions only", () => {
    const groups = groupSessions(
      [s("a", "web", "claude"), s("b", "api", "codex"), s("c", "web", "codex")],
      "workspace",
    );
    expect(groups.map((g) => g.key)).toEqual(["web", "api"]);
    expect(groups[0]!.sessions.map((x) => x.alias)).toEqual(["a", "c"]);
    expect(groups[1]!.sessions.map((x) => x.alias)).toEqual(["b"]);
  });

  it("groups by agent", () => {
    const groups = groupSessions(
      [
        s("a", "web", "claude"),
        s("b", "api", "codex"),
        s("c", "web", "claude"),
      ],
      "agent",
    );
    expect(groups.map((g) => g.key)).toEqual(["claude", "codex"]);
    expect(groups[0]!.sessions.map((x) => x.alias)).toEqual(["a", "c"]);
  });

  it("sinks archived sessions to the bottom of their group (stable)", () => {
    const groups = groupSessions(
      [
        s("arch1", "web", "claude", true),
        s("live1", "web", "claude"),
        s("arch2", "web", "codex", true),
        s("live2", "web", "codex"),
      ],
      "workspace",
    );
    expect(groups[0]!.sessions.map((x) => x.alias)).toEqual([
      "live1",
      "live2",
      "arch1",
      "arch2",
    ]);
  });

  it("orders archived sessions by sleep time, most recently slept first", () => {
    const arch = (alias: string, archivedAt?: string) => ({
      ...s(alias, "web", "claude", true),
      ...(archivedAt ? { archivedAt } : {}),
    });
    const sorted = archivedLast([
      s("live", "web", "claude"),
      arch("old-sleep", "2026-08-01T00:00:00Z"),
      arch("fresh-sleep", "2026-08-17T00:00:00Z"),
      arch("legacy-sleep"), // old connector: no timestamp
      arch("mid-sleep", "2026-08-09T00:00:00Z"),
    ]);
    // Actives keep incoming order; archived sink below, newest sleep on top so a
    // user expanding the sleeping list finds the latest sessions without paging.
    expect(sorted.map((x) => x.alias)).toEqual([
      "live",
      "fresh-sleep",
      "mid-sleep",
      "old-sleep",
      "legacy-sleep",
    ]);
  });

  it("returns no groups for no sessions", () => {
    expect(groupSessions([], "workspace")).toEqual([]);
  });
});

describe("dedupedSessionName", () => {
  it("strips the leading '<workspace>-' inside a workspace group", () => {
    expect(dedupedSessionName("web-claude", "web", "workspace")).toBe("claude");
  });

  it("strips the trailing '-<agent>' inside an agent group", () => {
    expect(dedupedSessionName("web-claude", "claude", "agent")).toBe("web");
  });

  it("leaves non-matching names untouched", () => {
    expect(dedupedSessionName("my-session", "web", "workspace")).toBe(
      "my-session",
    );
    expect(dedupedSessionName("my-session", "claude", "agent")).toBe(
      "my-session",
    );
  });

  it("never dedups down to an empty name", () => {
    expect(dedupedSessionName("web-", "web", "workspace")).toBe("web-");
    expect(dedupedSessionName("-claude", "claude", "agent")).toBe("-claude");
  });
});

describe("sessionPresentationName", () => {
  it("uses custom displayName when present under any mode", () => {
    expect(
      sessionPresentationName({
        displayName: "发布机器人",
        alias: "weacpx-github-omp-2",
        workspace: "weacpx-github",
        groupMode: "workspace",
      }),
    ).toBe("发布机器人");
    expect(
      sessionPresentationName({
        displayName: "发布机器人",
        alias: "omp-2",
        groupMode: "instance",
      }),
    ).toBe("发布机器人");
  });

  it("dedups alias in workspace mode by stripping leading <workspace>-", () => {
    expect(
      sessionPresentationName({
        alias: "weacpx-github-omp-2",
        workspace: "weacpx-github",
        groupMode: "workspace",
      }),
    ).toBe("omp-2");
  });

  it("dedups alias in agent mode by stripping trailing -<agent>", () => {
    expect(
      sessionPresentationName({
        alias: "omp-2-codex",
        agent: "codex",
        groupMode: "agent",
      }),
    ).toBe("omp-2");
  });

  it("preserves alias unchanged in flat instance mode or when no group key matches", () => {
    expect(
      sessionPresentationName({
        alias: "weacpx-github-omp-2",
        workspace: "weacpx-github",
        groupMode: "instance",
      }),
    ).toBe("weacpx-github-omp-2");
    expect(
      sessionPresentationName({
        alias: "custom-alias",
        workspace: "weacpx-github",
        groupMode: "workspace",
      }),
    ).toBe("custom-alias");
  });
});

describe("shortestUniqueSuffix", () => {
  it("returns 5-char tail when 5-char tails are unique", () => {
    const k1 = "node-1:endpoint_worker_1234a";
    const k2 = "node-1:endpoint_worker_5678b";
    expect(shortestUniqueSuffix(k1, [k1, k2], 5)).toBe("…1234a");
    expect(shortestUniqueSuffix(k2, [k1, k2], 5)).toBe("…5678b");
  });

  it("expands suffix dynamically when 5-char tails collide", () => {
    const k1 = "node-1:endpoint_worker_A12345";
    const k2 = "node-1:endpoint_worker_B12345";
    // 5 chars "12345" collide -> expands to 6 chars "A12345" vs "B12345"
    expect(shortestUniqueSuffix(k1, [k1, k2], 5)).toBe("…A12345");
    expect(shortestUniqueSuffix(k2, [k1, k2], 5)).toBe("…B12345");
  });

  it("expands to include node discriminator when endpointIds are completely identical across nodes", () => {
    const k1 = "node-alpha:endpoint_worker_default";
    const k2 = "node-beta:endpoint_worker_default";
    // "endpoint_worker_default" is identical -> expands until node difference is included
    expect(shortestUniqueSuffix(k1, [k1, k2], 5)).toBe(
      "…ha:endpoint_worker_default",
    );
    expect(shortestUniqueSuffix(k2, [k1, k2], 5)).toBe(
      "…ta:endpoint_worker_default",
    );
  });
});
