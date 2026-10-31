import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ToastHost from "../components/ToastHost.vue";
import { dismissToast, pushToast, useToasts } from "../lib/use-toasts";
import { i18n } from "../i18n";

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  useToasts().value = [];
  document.body.innerHTML = "";
});

describe("ToastHost placement", () => {
  it("sits in the conversation header's empty space, not over the transcript", async () => {
    const header = document.createElement("div");
    header.setAttribute("data-conversation-header", "");
    // A header band 40px below the top of the viewport.
    header.getBoundingClientRect = () => ({
      top: 40, left: 100, width: 800, height: 44,
      right: 900, bottom: 84, x: 100, y: 40,
      toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(header);

    const w = mount(ToastHost, { attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(w);
    pushToast("success", "files.toast.created", { name: "a" });
    await flushPromises();
    await nextTick();

    const stack = document.querySelector<HTMLElement>('[data-test="toast"]')!.parentElement!;
    // 8px below the header band's top edge, horizontally centred on it.
    expect(stack.style.top).toBe("48px");
    expect(stack.style.left).toBe("500px");
    expect(stack.style.transform).toBe("translateX(-50%)");
    // It is a fixed overlay anchored to the header, NOT pinned to the viewport top.
    expect(stack.style.top).not.toBe("0px");
  });

  it("renders the toast as a glass-strong surface with a status icon", async () => {
    const w = mount(ToastHost, { attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(w);
    pushToast("error", "files.toast.failed", { msg: "boom" });
    await flushPromises();

    const toast = document.querySelector<HTMLElement>('[data-test="toast"]')!;
    const cls = toast.className.split(/\s+/);
    expect(cls).toContain("bg-glass-strong");
    expect(cls).toContain("backdrop-blur-glass");
    expect(cls).toContain("shadow-glass-float");
    expect(cls).toContain("rounded-lg");
    expect(cls).toContain("h-9");
    // The status icon carries the tone; the error tone is a danger glyph.
    const icon = toast.querySelector("svg")!;
    expect(icon.getAttribute("class") ?? "").toContain("text-danger-overlay");
  });
});
