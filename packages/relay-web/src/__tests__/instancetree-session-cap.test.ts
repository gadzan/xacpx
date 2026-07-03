import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore } from "../stores/instances";

function makeSessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    alias: `s${i}`,
    agent: "claude",
    workspace: "home",
    transportSession: `t${i}`,
    running: false,
    archived: false,
  }));
}

const instance = (sessions: unknown[]) => ({
  id: "i1", name: "pc", online: true, lastSeenAt: null, sessions, sessionsLoaded: true, agents: [], workspaces: [],
});

describe("InstanceTree session-list cap", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("caps the session list at 10 with a show-more/collapse toggle", async () => {
    const store = useInstancesStore();
    store.instances = [instance(makeSessions(13))] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    // Capped to 10 rows by default.
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(10);
    const showMore = w.find('[data-test="sessions-show-more"]');
    expect(showMore.exists()).toBe(true);
    expect(showMore.text()).toContain("3");
    expect(w.find('[data-test="sessions-collapse"]').exists()).toBe(false);

    // Expand: all 13 rows show, button flips to collapse.
    await showMore.trigger("click");
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(13);
    expect(w.find('[data-test="sessions-show-more"]').exists()).toBe(false);
    const collapse = w.find('[data-test="sessions-collapse"]');
    expect(collapse.exists()).toBe(true);

    // Collapse: back to 10.
    await collapse.trigger("click");
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(10);
    expect(w.find('[data-test="sessions-show-more"]').exists()).toBe(true);
  });

  it("does not render a show-more/collapse toggle when at or under the cap", () => {
    const store = useInstancesStore();
    store.instances = [instance(makeSessions(10))] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(10);
    expect(w.find('[data-test="sessions-show-more"]').exists()).toBe(false);
    expect(w.find('[data-test="sessions-collapse"]').exists()).toBe(false);
  });

  it("isolates expand state per instance", async () => {
    const store = useInstancesStore();
    store.instances = [
      { ...instance(makeSessions(13)), id: "i1", name: "pc1" },
      { ...instance(makeSessions(13)), id: "i2", name: "pc2" },
    ] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    // 10 + 10 rows initially, two show-more buttons.
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(20);
    const showMores = w.findAll('[data-test="sessions-show-more"]');
    expect(showMores).toHaveLength(2);

    // Expanding the first instance only affects its own rows.
    await showMores[0]!.trigger("click");
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(23); // 13 + 10
    expect(w.findAll('[data-test="sessions-show-more"]')).toHaveLength(1);
    expect(w.findAll('[data-test="sessions-collapse"]')).toHaveLength(1);
  });

  it("preserves session ordering (active first, archived last) under the cap", () => {
    const store = useInstancesStore();
    const sessions = [
      ...makeSessions(9).map((s) => ({ ...s, archived: true })),
      { alias: "z-active", agent: "claude", workspace: "home", transportSession: "tz", running: false, archived: false },
      { alias: "y-active", agent: "claude", workspace: "home", transportSession: "ty", running: false, archived: false },
    ];
    store.instances = [instance(sessions)] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const rows = w.findAll('[data-test="session-row"]');
    expect(rows).toHaveLength(10);
    // Active sessions sink to the top even though they were appended last in source order.
    const names = rows.map((r) => r.find('[data-test="session-name"]').text());
    expect(names[0]).toBe("z-active");
    expect(names[1]).toBe("y-active");
  });
});
