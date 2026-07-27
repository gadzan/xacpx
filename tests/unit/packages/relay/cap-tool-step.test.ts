// tests/unit/packages/relay/cap-tool-step.test.ts
import { expect, test } from "bun:test";
import type { ToolStepDto } from "../../../../packages/relay-protocol/src/index";
import { capSeededStructured, capToolStep } from "../../../../packages/relay/src/server";

const CAP = 32 * 1024;
const big = "x".repeat(CAP + 100);

function step(detail?: ToolStepDto["detail"]): ToolStepDto {
  return { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "run", ...(detail ? { detail } : {}) };
}

test("returns the same object when there is no detail or everything fits", () => {
  const noDetail = step();
  expect(capToolStep(noDetail)).toBe(noDetail);
  const small = step({ type: "diff", path: "a.ts", oldText: "old", newText: "new" });
  expect(capToolStep(small)).toBe(small);
});

test("truncates oversized diff oldText/newText to the cap", () => {
  const capped = capToolStep(step({ type: "diff", path: "a.ts", oldText: big, newText: big }));
  const d = capped.detail as Extract<NonNullable<ToolStepDto["detail"]>, { type: "diff" }>;
  expect(d.oldText.length).toBe(CAP + 1); // cap + ellipsis
  expect(d.oldText.endsWith("…")).toBe(true);
  expect(d.newText.length).toBe(CAP + 1);
});

test("truncates command output but keeps command and exitCode", () => {
  const capped = capToolStep(step({ type: "command", command: "cat huge.log", output: big, exitCode: 0 }));
  const d = capped.detail as Extract<NonNullable<ToolStepDto["detail"]>, { type: "command" }>;
  expect(d.command).toBe("cat huge.log");
  expect(d.exitCode).toBe(0);
  expect(d.output!.length).toBe(CAP + 1);
});

test("truncates read preview, search output and text", () => {
  const read = capToolStep(step({ type: "read", path: "a.ts", preview: big })).detail as { preview?: string };
  expect(read.preview!.length).toBe(CAP + 1);
  const search = capToolStep(step({ type: "search", query: "q", output: big })).detail as { output?: string };
  expect(search.output!.length).toBe(CAP + 1);
  const text = capToolStep(step({ type: "text", text: big })).detail as { text: string };
  expect(text.text.length).toBe(CAP + 1);
});

test("truncates oversized fields values and output, leaving small fields intact", () => {
  const capped = capToolStep(step({ type: "fields", fields: [{ label: "big", value: big }, { label: "small", value: "ok" }], output: big }));
  const d = capped.detail as Extract<NonNullable<ToolStepDto["detail"]>, { type: "fields" }>;
  expect(d.fields[0]!.value.length).toBe(CAP + 1);
  expect(d.fields[1]!.value).toBe("ok");
  expect(d.output!.length).toBe(CAP + 1);
});

test("does not mutate the original step when truncating", () => {
  const original = step({ type: "command", command: "c", output: big });
  const capped = capToolStep(original);
  expect(capped).not.toBe(original);
  expect((original.detail as { output?: string }).output!.length).toBe(big.length);
});

test("caps top-level step strings like title and error too", () => {
  const capped = capToolStep({ ...step(), title: big, error: big });
  expect(capped.title.length).toBe(CAP + 1);
  expect(capped.error!.length).toBe(CAP + 1);
});

test("capSeededStructured caps nested strings in seeded history and is identity when small", () => {
  const small = { toolSteps: [step({ type: "text", text: "ok" })] };
  expect(capSeededStructured(small)).toBe(small);
  const structured = {
    toolSteps: [step({ type: "text", text: big })],
    parts: [{ type: "tool", step: step({ type: "command", command: "c", output: big }) }],
    reasoning: big,
  };
  const capped = capSeededStructured(structured);
  expect(capped).not.toBe(structured);
  expect((capped.toolSteps[0]!.detail as { text: string }).text.length).toBe(CAP + 1);
  expect((capped.parts[0]!.step.detail as { output?: string }).output!.length).toBe(CAP + 1);
  expect(capped.reasoning.length).toBe(CAP + 1);
  // original untouched
  expect(structured.reasoning.length).toBe(big.length);
});
