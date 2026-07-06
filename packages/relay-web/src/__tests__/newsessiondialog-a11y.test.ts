import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import NewSessionDialog from "../components/NewSessionDialog.vue";
import { useInstancesStore } from "../stores/instances";

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  document.body.innerHTML = "";
});

// Mount with the REAL Teleport (content lands on document.body) and attachTo, so focus()
// actually moves document.activeElement and keydowns bubble to the document listener.
// (The teleport STUB re-creates the dialog subtree when `loading` flips, dropping focus —
// a stub artifact the real Teleport doesn't have.) Teleported nodes aren't reachable via
// wrapper.find, so DOM assertions go through document.querySelector.
function mountDialog() {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "pc", online: true, lastSeenAt: null,
    sessions: [],
    agents: [{ name: "codex", driver: "codex" }],
    workspaces: [{ name: "home", cwd: "/Users/me" }],
    agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
  }] as never;
  vi.spyOn(store, "loadFormOptions").mockResolvedValue();
  vi.spyOn(store, "listNativeSessions").mockResolvedValue([]);
  vi.spyOn(store, "listModelSuggestions").mockResolvedValue([]);
  const wrapper = mount(NewSessionDialog, {
    props: { instanceId: "i1", instanceName: "pc" },
    attachTo: document.body,
  });
  return { wrapper, store };
}

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[data-test="new-session-dialog"]')!;
const q = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

describe("NewSessionDialog accessibility", () => {
  it("exposes the dialog role contract (role, aria-modal, labelled title)", async () => {
    const { wrapper } = mountDialog();
    await flushPromises();
    const dlg = dialog();
    expect(dlg.getAttribute("role")).toBe("dialog");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dlg.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toContain("New session");
    wrapper.unmount();
  });

  it("Escape closes the dialog", async () => {
    const { wrapper } = mountDialog();
    await flushPromises();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });

  it("Escape with the model popup open closes only the popup; a second Escape closes the dialog", async () => {
    const { wrapper } = mountDialog();
    await flushPromises();
    const model = q<HTMLInputElement>('[data-test="ns-model"]');
    model.focus();
    await nextTick();
    expect(document.querySelector('[data-test="ns-model-list"]')).toBeTruthy();
    model.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(document.querySelector('[data-test="ns-model-list"]')).toBeNull(); // popup closed
    expect(wrapper.emitted("close")).toBeFalsy(); // stopPropagation kept the dialog open
    model.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });

  it("moves focus into the dialog on open", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const { wrapper } = mountDialog();
    await flushPromises();
    expect(dialog().contains(document.activeElement)).toBe(true);
    wrapper.unmount();
  });

  it("traps Tab focus: Tab on the last element wraps to the first, Shift+Tab wraps back", async () => {
    const { wrapper } = mountDialog();
    await flushPromises();
    const focusable = dialog().querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(first);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(last);
    wrapper.unmount();
  });

  it("restores focus to the previously focused element on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { wrapper } = mountDialog();
    await flushPromises();
    expect(document.activeElement).not.toBe(opener);
    wrapper.unmount();
    expect(document.activeElement).toBe(opener);
  });
});
