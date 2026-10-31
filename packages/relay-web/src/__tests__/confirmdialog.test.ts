import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { confirm, settleConfirm, useConfirmState } from "../lib/use-confirm";

afterEach(() => { settleConfirm(false); vi.restoreAllMocks(); });

describe("ConfirmDialog + confirm()", () => {
  it("is hidden until confirm() opens it, then shows title/message/labels", async () => {
    const w = mount(ConfirmDialog, { attachTo: document.body });
    expect(document.querySelector('[data-test="confirm-dialog"]')).toBeNull();
    void confirm({ title: "Delete session?", message: "gone forever", confirmLabel: "Delete", tone: "danger" });
    await flushPromises();
    const dialog = document.querySelector('[data-test="confirm-dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Delete session?");
    expect(dialog.textContent).toContain("gone forever");
    expect(document.querySelector('[data-test="confirm-ok"]')!.textContent).toContain("Delete");
    w.unmount();
  });

  it("resolves true on confirm and closes", async () => {
    mount(ConfirmDialog, { attachTo: document.body });
    const p = confirm({ title: "Sign out?" });
    await flushPromises();
    (document.querySelector('[data-test="confirm-ok"]') as HTMLElement).click();
    await expect(p).resolves.toBe(true);
    expect(useConfirmState().value).toBeNull();
  });

  it("resolves false on cancel", async () => {
    mount(ConfirmDialog, { attachTo: document.body });
    const p = confirm({ title: "Remove agent?" });
    await flushPromises();
    (document.querySelector('[data-test="confirm-cancel"]') as HTMLElement).click();
    await expect(p).resolves.toBe(false);
  });

  it("ignores the scrim click that finishes a double-click, then cancels on a later one", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mount(ConfirmDialog, { attachTo: document.body });
    let settled: boolean | null = null;
    void confirm({ title: "Stop all?" }).then((v) => { settled = v; });
    await flushPromises();
    const scrim = document.querySelector('[data-test="confirm-scrim"]') as HTMLElement;
    now = 1120;
    scrim.click();
    await flushPromises();
    expect(settled).toBeNull();
    expect(document.querySelector('[data-test="confirm-dialog"]')).not.toBeNull();
    now = 1600;
    scrim.click();
    await flushPromises();
    await vi.waitFor(() => expect(settled).toBe(false));
  });

  it("a second confirm() supersedes the first (resolves it false)", async () => {
    mount(ConfirmDialog, { attachTo: document.body });
    const first = confirm({ title: "first" });
    const second = confirm({ title: "second" });
    await expect(first).resolves.toBe(false);
    expect(useConfirmState().value?.title).toBe("second");
    settleConfirm(true);
    await expect(second).resolves.toBe(true);
  });
});
