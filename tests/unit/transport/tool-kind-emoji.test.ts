import { describe, expect, test } from "bun:test";

import { TOOL_KIND_EMOJI, DEFAULT_TOOL_EMOJI } from "../../../src/transport/tool-kind-emoji";

describe("TOOL_KIND_EMOJI", () => {
  test("maps 'read' to book emoji", () => {
    expect(TOOL_KIND_EMOJI.read).toBe("\u{1F4D6}");
  });

  test("maps 'search' to magnifying glass emoji", () => {
    expect(TOOL_KIND_EMOJI.search).toBe("\u{1F50D}");
  });

  test("maps 'execute' to computer emoji", () => {
    expect(TOOL_KIND_EMOJI.execute).toBe("\u{1F4BB}");
  });

  test("maps 'edit' to pencil emoji", () => {
    expect(TOOL_KIND_EMOJI.edit).toBe("\u{270F}\u{FE0F}");
  });

  test("maps 'think' to brain emoji", () => {
    expect(TOOL_KIND_EMOJI.think).toBe("\u{1F9E0}");
  });

  test("maps 'other' to wrench emoji", () => {
    expect(TOOL_KIND_EMOJI.other).toBe("\u{1F527}");
  });
});

describe("DEFAULT_TOOL_EMOJI", () => {
  test("equals TOOL_KIND_EMOJI.other", () => {
    expect(DEFAULT_TOOL_EMOJI).toBe(TOOL_KIND_EMOJI.other);
  });
});