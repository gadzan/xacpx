import { describe, test, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { githubHighlight } from "../lib/cm-theme";

describe("cm-theme", () => {
  test("githubHighlight is a usable CodeMirror extension", () => {
    // If it weren't a valid Extension, EditorState.create would throw.
    const state = EditorState.create({ doc: "x", extensions: [githubHighlight] });
    expect(state).toBeTruthy();
  });
});
