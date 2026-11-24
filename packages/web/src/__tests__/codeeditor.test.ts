import { describe, test, expect } from "vitest";
import { mount } from "@vue/test-utils";
import CodeEditor from "../components/CodeEditor.vue";

type Exposed = { view: { state: { doc: { toString(): string; length: number }; readOnly: boolean }; dispatch: (t: unknown) => void }; openSearch: () => void };

describe("CodeEditor", () => {
  test("renders content read-only by default", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "hello world", filename: "a.ts" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.element.textContent).toContain("hello world");
    const vm = w.vm as unknown as Exposed;
    expect(vm.view.state.readOnly).toBe(true);
    w.unmount();
  });

  test("editable=true makes the document editable and emits update:modelValue", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "a", filename: "a.txt", editable: true } });
    await new Promise((r) => setTimeout(r, 0));
    const vm = w.vm as unknown as Exposed;
    expect(vm.view.state.readOnly).toBe(false);
    vm.view.dispatch({ changes: { from: vm.view.state.doc.length, insert: "b" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.emitted("update:modelValue")?.at(-1)?.[0]).toBe("ab");
    w.unmount();
  });

  test("toggling editable reconfigures read-only without remounting", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "a", filename: "a.txt", editable: false } });
    await new Promise((r) => setTimeout(r, 0));
    const vm = w.vm as unknown as Exposed;
    expect(vm.view.state.readOnly).toBe(true);
    await w.setProps({ editable: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(vm.view.state.readOnly).toBe(false);
    w.unmount();
  });

  test("openSearch is exposed and callable", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "abc", filename: "a.txt" } });
    await new Promise((r) => setTimeout(r, 0));
    const vm = w.vm as unknown as Exposed;
    expect(typeof vm.openSearch).toBe("function");
    expect(() => vm.openSearch()).not.toThrow();
    w.unmount();
  });
});
