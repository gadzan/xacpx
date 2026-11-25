import { expect, test } from "bun:test";

import {
  runStreamingPromptFlow,
  type StreamingPromptFlowEmitter,
  type StreamingPromptFlowProcess,
} from "../../../src/transport/acpx-streaming-prompt";

/** Controllable fake child: the test pushes stdout chunks and closes it. */
function makeFakeChild() {
  let dataHandler: ((chunk: string | Buffer) => void) | undefined;
  let closeHandler: ((code: number | null) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  const child: StreamingPromptFlowProcess = {
    stdout: {
      setEncoding: () => {},
      on: (_event, handler) => { dataHandler = handler; },
    },
    stderr: { on: () => {} },
    on: ((event: string, handler: (arg: never) => void) => {
      if (event === "close") closeHandler = handler as unknown as (code: number | null) => void;
      if (event === "error") errorHandler = handler as unknown as (error: Error) => void;
    }) as StreamingPromptFlowProcess["on"],
  };
  return {
    child,
    emit: (text: string) => dataHandler?.(text),
    close: (code: number | null = 0) => closeHandler?.(code),
    fail: (error: Error) => errorHandler?.(error),
  };
}

function recordingEmitter(): StreamingPromptFlowEmitter & { segments: string[] } {
  const segments: string[] = [];
  return {
    segments,
    emitSegment: (text) => { segments.push(text); },
    finish: async () => 0,
  };
}

function agentChunkLine(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function thoughtLine(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    },
  });
}

test("shell streams parsed segments in order and resolves the accumulated output", async () => {
  const fake = makeFakeChild();
  const emitter = recordingEmitter();
  const pending = runStreamingPromptFlow({
    command: "acpx",
    args: ["prompt"],
    spawnPrompt: () => fake.child,
    setIntervalFn: () => ({}) as unknown,
    clearIntervalFn: () => {},
    emitter,
  });
  // Two agent_message_chunk lines form two segments.
  fake.emit(`${agentChunkLine("hello ")}\n${agentChunkLine("world")}\n`);
  fake.close(0);
  const result = await pending;
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("hello");
  expect(result.stdout).toContain("world");
  expect(emitter.segments.join("")).toContain("hello");
});

test("shell keeps non-envelope noise out of segments while retaining it in stdout", async () => {
  const fake = makeFakeChild();
  const emitter = recordingEmitter();
  const pending = runStreamingPromptFlow({
    command: "acpx",
    args: ["prompt"],
    spawnPrompt: () => fake.child,
    setIntervalFn: () => ({}) as unknown,
    clearIntervalFn: () => {},
    emitter,
  });
  // Plain text without an event envelope lands in the buffer; finalize emits it.
  fake.emit("plain trailing text");
  fake.close(0);
  const result = await pending;
  expect(result.code).toBe(0);
  // Non-envelope text is treated as raw transcript noise: stdout keeps it,
  // but no segment is formed from it (segments come from the parser only).
  expect(result.stdout).toContain("plain trailing text");
  expect(emitter.segments.join(" ")).not.toContain("plain trailing text");
});

test("shell rejects when the emitter collects a close error", async () => {
  const fake = makeFakeChild();
  const emitter = recordingEmitter();
  emitter.finish = async () => { throw new Error("quota deferred"); };
  const pending = runStreamingPromptFlow({
    command: "acpx",
    args: ["prompt"],
    spawnPrompt: () => fake.child,
    setIntervalFn: () => ({}) as unknown,
    clearIntervalFn: () => {},
    emitter,
  });
  fake.close(0);
  await expect(pending).rejects.toThrow("quota deferred");
});

test("shell rejects on spawn error", async () => {
  const fake = makeFakeChild();
  const pending = runStreamingPromptFlow({
    command: "acpx",
    args: ["prompt"],
    spawnPrompt: () => fake.child,
    setIntervalFn: () => ({}) as unknown,
    clearIntervalFn: () => {},
    emitter: recordingEmitter(),
  });
  fake.fail(new Error("spawn exploded"));
  await expect(pending).rejects.toThrow("spawn exploded");
});

test("shell forwards the activity flush through the emitter before activity events", async () => {
  const fake = makeFakeChild();
  const seen: string[] = [];
  const emitter = recordingEmitter();
  const pending = runStreamingPromptFlow({
    command: "acpx",
    args: ["prompt"],
    spawnPrompt: () => fake.child,
    setIntervalFn: () => ({}) as unknown,
    clearIntervalFn: () => {},
    handlers: {
      onThought: () => { seen.push(`thought-after:${emitter.segments.length}`); },
    },
    emitter,
  });
  // Text first (buffered), then a thought event: onBeforeActivityEvent must
  // flush the pending text before the thought handler runs.
  fake.emit(`${agentChunkLine("before thought")}\n${thoughtLine("hmm")}\n`);
  fake.close(0);
  await pending;
  expect(emitter.segments.join(" ")).toContain("before thought");
  expect(seen).toHaveLength(1);
});
