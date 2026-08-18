import { afterEach, describe, expect, it } from "vitest";
import { loadGroupMode, saveGroupMode, groupSessions, dedupedSessionName, archivedLast } from "../lib/sidebar-group-mode";

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

const s = (alias: string, workspace: string, agent: string, archived = false) => ({ alias, workspace, agent, archived });

describe("groupSessions", () => {
  it("groups by workspace in first-appearance order, derived from sessions only", () => {
    const groups = groupSessions([s("a", "web", "claude"), s("b", "api", "codex"), s("c", "web", "codex")], "workspace");
    expect(groups.map((g) => g.key)).toEqual(["web", "api"]);
    expect(groups[0]!.sessions.map((x) => x.alias)).toEqual(["a", "c"]);
    expect(groups[1]!.sessions.map((x) => x.alias)).toEqual(["b"]);
  });

  it("groups by agent", () => {
    const groups = groupSessions([s("a", "web", "claude"), s("b", "api", "codex"), s("c", "web", "claude")], "agent");
    expect(groups.map((g) => g.key)).toEqual(["claude", "codex"]);
    expect(groups[0]!.sessions.map((x) => x.alias)).toEqual(["a", "c"]);
  });

  it("sinks archived sessions to the bottom of their group (stable)", () => {
    const groups = groupSessions(
      [s("arch1", "web", "claude", true), s("live1", "web", "claude"), s("arch2", "web", "codex", true), s("live2", "web", "codex")],
      "workspace",
    );
    expect(groups[0]!.sessions.map((x) => x.alias)).toEqual(["live1", "live2", "arch1", "arch2"]);
  });

  it("orders archived sessions by sleep time, most recently slept first", () => {
    const arch = (alias: string, archivedAt?: string) => ({ ...s(alias, "web", "claude", true), ...(archivedAt ? { archivedAt } : {}) });
    const sorted = archivedLast([
      s("live", "web", "claude"),
      arch("old-sleep", "2026-08-01T00:00:00Z"),
      arch("fresh-sleep", "2026-08-17T00:00:00Z"),
      arch("legacy-sleep"), // old connector: no timestamp
      arch("mid-sleep", "2026-08-09T00:00:00Z"),
    ]);
    // Actives keep incoming order; archived sink below, newest sleep on top so a
    // user expanding the sleeping list finds the latest sessions without paging.
    expect(sorted.map((x) => x.alias)).toEqual(["live", "fresh-sleep", "mid-sleep", "old-sleep", "legacy-sleep"]);
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
    expect(dedupedSessionName("my-session", "web", "workspace")).toBe("my-session");
    expect(dedupedSessionName("my-session", "claude", "agent")).toBe("my-session");
  });

  it("never dedups down to an empty name", () => {
    expect(dedupedSessionName("web-", "web", "workspace")).toBe("web-");
    expect(dedupedSessionName("-claude", "claude", "agent")).toBe("-claude");
  });
});
