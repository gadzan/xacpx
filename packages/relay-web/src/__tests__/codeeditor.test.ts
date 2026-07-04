import { describe, test, expect } from "vitest";
import { mount } from "@vue/test-utils";
import CodeEditor from "../components/CodeEditor.vue";

describe("CodeEditor", () => {
  test("renders the initial content into the CodeMirror document", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "hello world", filename: "a.ts" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.element.textContent).toContain("hello world");
    w.unmount();
  });

  test("emits update:modelValue when the document changes", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "a", filename: "a.txt" } });
    await new Promise((r) => setTimeout(r, 0));
    // Access the exposed view to dispatch a change (component exposes `view` for testing).
    const view = (w.vm as unknown as { view: { dispatch: (t: unknown) => void; state: { doc: { length: number } } } }).view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "b" } });
    await new Promise((r) => setTimeout(r, 0));
    const events = w.emitted("update:modelValue");
    expect(events?.at(-1)?.[0]).toBe("ab");
    w.unmount();
  });
});
