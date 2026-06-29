import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import CommandPalette from "../components/CommandPalette.vue";
import { useInstancesStore } from "../stores/instances";

function seed() {
  const instances = useInstancesStore();
  instances.instances = [
    { id: "i1", name: "prod-box", online: true, lastSeenAt: null, agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "codex", workspace: "gaia" }, { alias: "frontend", agent: "claude", workspace: "web" }] },
  ] as never;
}

describe("CommandPalette", () => {
  beforeEach(() => { setActivePinia(createPinia()); seed(); });

  it("lists sessions across instances", () => {
    const w = mount(CommandPalette);
    const rows = w.findAll('[data-test="palette-row"]');
    expect(rows.length).toBe(2); // two seeded sessions, no xacpx command rows
    expect(rows[0].text()).toContain("backend");
    expect(rows[1].text()).toContain("frontend");
    // The dashboard is GUI-first: xacpx slash commands are no longer surfaced here.
    expect(w.text()).not.toContain("/status");
  });

  it("filters by the query across label and subtitle", async () => {
    const w = mount(CommandPalette);
    await w.find('[data-test="palette-input"]').setValue("frontend");
    const rows = w.findAll('[data-test="palette-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("frontend");
  });

  it("emits select-session when a session row is chosen", async () => {
    const w = mount(CommandPalette);
    await w.find('[data-test="palette-input"]').setValue("backend");
    await w.find('[data-test="palette-row"]').trigger("click");
    expect(w.emitted("select-session")?.[0]).toEqual(["i1", "backend"]);
    expect(w.emitted("close")).toBeTruthy();
  });

  it("Enter selects the active row, Escape closes", async () => {
    const w = mount(CommandPalette);
    const input = w.find('[data-test="palette-input"]');
    await input.setValue("frontend");
    await input.trigger("keydown", { key: "Enter" });
    expect(w.emitted("select-session")?.[0]).toEqual(["i1", "frontend"]);
    await input.trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toBeTruthy();
  });

  it("ArrowDown moves the active row", async () => {
    const w = mount(CommandPalette);
    const input = w.find('[data-test="palette-input"]');
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "Enter" });
    // second session row is "frontend"
    expect(w.emitted("select-session")?.[0]).toEqual(["i1", "frontend"]);
  });

  describe("displayName support", () => {
    beforeEach(() => {
      const instances = useInstancesStore();
      instances.instances = [
        { id: "i2", name: "staging-box", online: true, lastSeenAt: null, agents: [], workspaces: [], agentCatalog: [],
          sessions: [{ alias: "backend", displayName: "API hotfix", agent: "codex", workspace: "gaia" }] },
      ] as never;
    });

    it("shows displayName in the row instead of raw alias", () => {
      const w = mount(CommandPalette);
      const rows = w.findAll('[data-test="palette-row"]');
      expect(rows[0].text()).toContain("API hotfix");
      expect(rows[0].text()).not.toContain("backend");
    });

    it("filters by displayName", async () => {
      const w = mount(CommandPalette);
      await w.find('[data-test="palette-input"]').setValue("API hotfix");
      const rows = w.findAll('[data-test="palette-row"]');
      expect(rows).toHaveLength(1);
      expect(rows[0].text()).toContain("API hotfix");
    });

    it("filters by original alias even when displayName is set", async () => {
      const w = mount(CommandPalette);
      await w.find('[data-test="palette-input"]').setValue("backend");
      const rows = w.findAll('[data-test="palette-row"]');
      expect(rows).toHaveLength(1);
      expect(rows[0].text()).toContain("API hotfix");
    });
  });
});
