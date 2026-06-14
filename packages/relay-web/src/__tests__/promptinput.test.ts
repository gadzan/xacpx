import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PromptInput from "../components/PromptInput.vue";
import { suggestCommands } from "../lib/command-catalog";

describe("suggestCommands", () => {
  it("suggests by first-token prefix", () => {
    expect(suggestCommands("/s").map((c) => c.name)).toContain("/session");
    expect(suggestCommands("/s").map((c) => c.name)).toContain("/status");
    expect(suggestCommands("/s").map((c) => c.name)).toContain("/ssn");
  });
  it("stops once an argument (space) begins", () => {
    expect(suggestCommands("/session new")).toEqual([]);
  });
  it("returns [] for non-slash input and exact complete matches", () => {
    expect(suggestCommands("hello")).toEqual([]);
    expect(suggestCommands("/status")).toEqual([]); // exact, nothing left to suggest
  });
});

describe("PromptInput composer", () => {
  it("shows a suggestion popover for a slash prefix and Tab completes it", async () => {
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("/se");
    expect(w.find('[data-test="cmd-suggestions"]').exists()).toBe(true);
    expect(w.find('[data-test="cmd-suggestions"]').text()).toContain("/session");
    await ta.trigger("keydown", { key: "Tab" });
    expect((ta.element as HTMLTextAreaElement).value).toBe("/session ");
    expect(w.find('[data-test="cmd-suggestions"]').exists()).toBe(false);
  });

  it("Esc dismisses the popover before anything else", async () => {
    const w = mount(PromptInput);
    await w.find("textarea").setValue("/se");
    expect(w.find('[data-test="cmd-suggestions"]').exists()).toBe(true);
    await w.find("textarea").trigger("keydown", { key: "Escape" });
    expect(w.find('[data-test="cmd-suggestions"]').exists()).toBe(false);
  });

  it("Enter sends a plain message and records it in history for ↑ recall", async () => {
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("hello there");
    await ta.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual(["hello there"]);
    expect((ta.element as HTMLTextAreaElement).value).toBe(""); // cleared
    // Caret at start of an empty field → ArrowUp recalls the last sent line.
    await ta.trigger("keydown", { key: "ArrowUp" });
    expect((ta.element as HTMLTextAreaElement).value).toBe("hello there");
  });

  it("does not send while a suggestion is active (Enter accepts instead)", async () => {
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("/sta");
    await ta.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toBeFalsy();
    expect((ta.element as HTMLTextAreaElement).value).toBe("/status ");
  });

  it("ignores Enter mid-IME-composition (CJK input)", async () => {
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("你好");
    await ta.trigger("keydown", { key: "Enter", isComposing: true });
    expect(w.emitted("send")).toBeFalsy(); // composition confirm, not submit
  });

  it("persists a per-session draft and restores it when the key returns", async () => {
    sessionStorage.clear();
    const w = mount(PromptInput, { props: { draftKey: "k1" } });
    await w.find("textarea").setValue("half-typed");
    await w.setProps({ draftKey: "k2" }); // switch session → draft stashed, k2 empty
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("");
    await w.setProps({ draftKey: "k1" }); // back → restored
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("half-typed");
  });
});
