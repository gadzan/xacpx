import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import CommandPalette from "../components/CommandPalette.vue";
import { useInstancesStore } from "../stores/instances";

afterEach(() => { document.body.innerHTML = ""; document.body.style.overflow = ""; });

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

  it("keeps rows and the search field at touch height (48px)", () => {
    const w = mount(CommandPalette);
    for (const row of w.findAll('[data-test="palette-row"]')) expect(row.classes()).toContain("min-h-12");
    expect(w.find('[data-test="palette-input"]').element.closest("div")!.className.split(/\s+/)).toContain("min-h-12");
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

  it("stays a top panel with 16px + safe-area side insets, 2xl corners and a 16px input", () => {
    const w = mount(CommandPalette);
    const root = w.find('[data-test="command-palette"]');
    const rootClasses = root.classes();
    // Top-anchored command surface, never a bottom sheet.
    expect(rootClasses).toContain("items-start");
    expect(rootClasses).toContain("bg-scrim");
    expect(rootClasses).not.toContain("items-end");
    expect(rootClasses).toEqual(expect.arrayContaining([
      "pl-[max(1rem,env(safe-area-inset-left))]",
      "pr-[max(1rem,env(safe-area-inset-right))]",
    ]));
    const panel = root.element.firstElementChild as HTMLElement;
    expect(panel.className.split(/\s+/)).toEqual(expect.arrayContaining(["w-full", "max-w-lg", "rounded-2xl"]));
    // 16px input: iOS must not zoom on focus.
    expect(w.find('[data-test="palette-input"]').classes()).toContain("text-base");
    // Selection background is inset by the list's own padding, never flush.
    expect(panel.querySelector("ul")!.className.split(/\s+/)).toContain("p-1");
    w.unmount();
  });

  it("restores focus to the opener on close and holds the body scroll lock", async () => {
    const opener = document.createElement("button");
    opener.id = "palette-opener";
    document.body.appendChild(opener);
    opener.focus();

    const w = mount(CommandPalette, { attachTo: document.body });
    await nextTick();
    // The palette takes the caret while open, then hands it back on close.
    expect(document.activeElement?.getAttribute("data-test")).toBe("palette-input");
    expect(document.body.style.overflow).toBe("hidden");
    w.unmount();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement?.id).toBe("palette-opener");
    opener.remove();
  });

  it("keeps the height it opened at while the query narrows the results", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 380 });
    try {
      const w = mount(CommandPalette, { attachTo: document.body });
      await nextTick();
      await nextTick();
      const panel = w.get('[data-test="command-palette"] > div');
      expect((panel.element as HTMLElement).style.minHeight).toBe("min(380px, calc(100dvh - 7rem))");

      // Narrowing to nothing must not shrink the panel under the caret.
      await w.get('[data-test="palette-input"]').setValue("no-such-session");
      await nextTick();
      expect(w.findAll('[data-test="palette-row"]')).toHaveLength(0);
      expect((panel.element as HTMLElement).style.minHeight).toBe("min(380px, calc(100dvh - 7rem))");
      w.unmount();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      else delete (HTMLElement.prototype as unknown as { offsetHeight?: number }).offsetHeight;
    }
  });

  it("a backdrop pointer sequence closes once on click and never reaches the page under it", async () => {
    const onNew = vi.fn();
    const covered = document.createElement("button");
    covered.setAttribute("data-test", "covered-new");
    covered.addEventListener("click", onNew);
    document.body.appendChild(covered);

    const w = mount(CommandPalette, { attachTo: document.body });
    await nextTick();
    const root = document.querySelector('[data-test="command-palette"]') as HTMLElement;
    const seq = (type: string) =>
      root.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));

    seq("pointerdown");
    await nextTick();
    expect(w.emitted("close")).toBeUndefined();
    seq("pointerup");
    seq("click");
    await nextTick();
    expect(w.emitted("close")).toHaveLength(1);
    expect(onNew).toHaveBeenCalledTimes(0);
    w.unmount();
    covered.remove();
  });
});
