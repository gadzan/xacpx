import { expect, test } from "bun:test";

import {
  checkElicitationRenderability,
  DISCORD_SELECT_OPTION_COUNT_MAX,
  DISCORD_TEXT_INPUT_LABEL_MAX,
} from "../../../../packages/channel-discord/src/elicitation-limits";
import type { ChannelElicitationField } from "xacpx/plugin-api";

function text(key: string, title = "What is the target?"): ChannelElicitationField {
  return { kind: "text", key, title, required: true };
}

function single(key: string, count: number): ChannelElicitationField {
  return {
    kind: "single-select",
    key,
    title: "Pick one",
    required: true,
    options: Array.from({ length: count }, (_, index) => ({
      value: `v${index}`,
      label: `Option ${index}`,
    })),
  };
}

test("a small mixed form renders", () => {
  const verdict = checkElicitationRenderability([
    text("target"),
    { kind: "boolean", key: "confirm", title: "Confirm?", required: true },
    single("env", 3),
    {
      kind: "multi-select",
      key: "tags",
      title: "Tags",
      required: false,
      minItems: 1,
      maxItems: 3,
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    },
    { kind: "number", key: "count", title: "How many?", required: false },
    { kind: "integer", key: "retries", title: "Retries", required: false },
    { kind: "date", key: "when", title: "When", required: false },
    { kind: "date-time", key: "exact", title: "Exact time", required: false },
    { kind: "email", key: "mail", title: "Email", required: false },
    { kind: "uri", key: "site", title: "Site", required: false },
  ]);
  expect(verdict.renderable).toBe(true);
  expect(verdict.reason).toBeUndefined();
});

test("a select over the platform option limit is rejected, not truncated", () => {
  const verdict = checkElicitationRenderability([single("env", DISCORD_SELECT_OPTION_COUNT_MAX + 1)]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-count");
  // The detail carries the decisive cause and no answer text.
  expect(verdict.detail).toContain("26");
  expect(verdict.detail).toContain('"env"');
});

test("a select at exactly the platform option limit still renders", () => {
  expect(checkElicitationRenderability([single("env", DISCORD_SELECT_OPTION_COUNT_MAX)]).renderable).toBe(true);
});

test("an option label over 100 chars is rejected as a different option, not a clipped one", () => {
  const verdict = checkElicitationRenderability([single("env", 1)]);
  const longer: ChannelElicitationField = {
    kind: "single-select",
    key: "env",
    title: "Pick one",
    required: true,
    options: [{ value: "x", label: "L".repeat(101) }],
  };
  expect(verdict.renderable).toBe(true);
  expect(checkElicitationRenderability([longer]).renderable).toBe(false);
  expect(checkElicitationRenderability([longer]).reason).toBe("select-option-label-too-long");
});

test("an option value over 100 chars is rejected", () => {
  const verdict = checkElicitationRenderability([
    {
      kind: "single-select",
      key: "env",
      title: "Pick one",
      required: true,
      options: [{ value: "v".repeat(101), label: "V" }],
    },
  ]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-option-value-too-long");
});

test("an option description over 100 chars is rejected", () => {
  const verdict = checkElicitationRenderability([
    single("env", 1),
  ]);
  expect(verdict.renderable).toBe(true);
  const withDescription = checkElicitationRenderability([
    {
      kind: "single-select",
      key: "env",
      title: "Pick one",
      required: true,
      options: [{ value: "v", label: "V", description: "d".repeat(101) }],
    },
  ]);
  expect(withDescription.renderable).toBe(false);
  expect(withDescription.reason).toBe("select-option-description-too-long");
});

test("a modal label over 45 chars is rejected: a clipped label is a different question", () => {
  const verdict = checkElicitationRenderability([text("target", "W".repeat(DISCORD_TEXT_INPUT_LABEL_MAX + 1))]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("field-label-too-long");
  expect(verdict.detail).toContain("46");
});

test("a modal label at exactly 45 chars still renders", () => {
  expect(checkElicitationRenderability([text("target", "W".repeat(DISCORD_TEXT_INPUT_LABEL_MAX))]).renderable).toBe(true);
});

test("a multi-select whose min/max demand exceeds the platform is rejected", () => {
  const verdict = checkElicitationRenderability([
    {
      kind: "multi-select",
      key: "tags",
      title: "Tags",
      required: true,
      minItems: 30,
      maxItems: 40,
      options: Array.from({ length: 25 }, (_, index) => ({ value: `v${index}`, label: `O${index}` })),
    },
  ]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("select-min-max-out-of-range");
});

test("a select with zero options is rejected before it becomes an empty Discord select", () => {
  const verdict = checkElicitationRenderability([
    { kind: "single-select", key: "env", title: "Pick one", required: true, options: [] },
  ]);
  expect(verdict.renderable).toBe(false);
  expect(verdict.reason).toBe("empty-select");
});
