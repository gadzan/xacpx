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

  it("lists sessions and commands, sessions first", () => {
    const w = mount(CommandPalette);
    const rows = w.findAll('[data-test="palette-row"]');
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0].text()).toContain("backend");
    expect(w.text()).toContain("/status"); // a command from the catalog
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

  it("emits pick-command when a command row is chosen", async () => {
    const w = mount(CommandPalette);
    await w.find('[data-test="palette-input"]').setValue("/status");
    await w.find('[data-test="palette-row"]').trigger("click");
    expect(w.emitted("pick-command")?.[0]).toEqual(["/status"]);
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
});
