import { describe, expect, test } from "bun:test";
import { mapRuntimeToolEvent } from "../../../../../src/bridge/engine/runtime-engine";

describe("RuntimeEngine mapRuntimeToolEvent (spec §9-§10, §13B)", () => {
  test("derives summary from rawInput and excludes summary when equal to title", () => {
    // rawInput has path
    const event1 = mapRuntimeToolEvent({
      toolCallId: "call-1",
      title: "Read",
      kind: "read",
      status: "completed",
      rawInput: { path: "/src/main.ts" },
    });

    expect(event1).toMatchObject({
      toolCallId: "call-1",
      toolName: "Read",
      kind: "read",
      status: "success",
      summary: "/src/main.ts",
      rawInput: { path: "/src/main.ts" },
    });

    // When summary equals title, summary is omitted (dedup)
    const event2 = mapRuntimeToolEvent({
      toolCallId: "call-2",
      title: "my-command",
      kind: "execute",
      status: "completed",
      rawInput: { command: "my-command" },
    });

    expect(event2.toolName).toBe("my-command");
    expect(event2.summary).toBeUndefined();
  });

  test("falls back to rawOutput when rawInput yields no summary", () => {
    const event = mapRuntimeToolEvent({
      toolCallId: "call-3",
      title: "Bash",
      kind: "execute",
      status: "completed",
      rawOutput: { stdout: "build succeeded" },
    });

    expect(event.summary).toBe("build succeeded");
  });

  test("preserves both rawInput and rawOutput on the mapped ToolUseEvent", () => {
    const event = mapRuntimeToolEvent({
      toolCallId: "call-4",
      title: "Bash",
      kind: "execute",
      status: "completed",
      rawInput: { command: "bun test" },
      rawOutput: { formatted_output: "10 passed", exit_code: 0 },
    });

    expect(event.rawInput).toEqual({ command: "bun test" });
    expect(event.rawOutput).toEqual({ formatted_output: "10 passed", exit_code: 0 });
    expect(event.status).toBe("success");
  });

  test("maps statuses correctly (completed/success -> success, failed/error -> error, running -> running)", () => {
    expect(mapRuntimeToolEvent({ status: "completed" }).status).toBe("success");
    expect(mapRuntimeToolEvent({ status: "SUCCESS" }).status).toBe("success");
    expect(mapRuntimeToolEvent({ status: "failed" }).status).toBe("error");
    expect(mapRuntimeToolEvent({ status: "Error" }).status).toBe("error");
    expect(mapRuntimeToolEvent({ status: "in_progress" }).status).toBe("running");
    expect(mapRuntimeToolEvent({ status: undefined }).status).toBe("running");
  });

  // Spec Test 10 — kind parity
  test("Test 10: kind parity preserves delete, move, and fetch without downgrading to other", () => {
    const deleteEvent = mapRuntimeToolEvent({
      toolCallId: "del-1",
      title: "Delete",
      kind: "delete",
      rawInput: { file_path: "temp.txt" },
    });
    expect(deleteEvent.kind).toBe("delete");

    const moveEvent = mapRuntimeToolEvent({
      toolCallId: "mv-1",
      title: "Move",
      kind: "move",
      rawInput: { source: "a.txt", destination: "b.txt" },
    });
    expect(moveEvent.kind).toBe("move");

    const fetchEvent = mapRuntimeToolEvent({
      toolCallId: "fetch-1",
      title: "Fetch",
      kind: "fetch",
      rawInput: { url: "https://example.com/api" },
    });
    expect(fetchEvent.kind).toBe("fetch");
  });
});
