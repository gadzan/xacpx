/**
 * Shared streaming-prompt shell (Phase 3b of the CLI/Bridge driver unification).
 *
 * Before: `AcpxCliTransport.runStreamingPrompt` (src/transport/acpx-cli/acpx-cli-transport.ts)
 * and `runStreamingPrompt` (src/bridge/bridge-runtime.ts) each owned the same
 * spawn → parse → segment → stall-timer → close shell, differing only in how
 * emitted text reaches the outside. The shell now lives here as
 * `runStreamingPromptFlow`, parameterized by handlers plus an emitter; the two
 * lanes keep their own delivery semantics, so behaviour is bit-identical:
 * - CLI: quota/verbatim reply sink, serialized callback queue, and
 *   plan/usage/commands chains with first-error-wins collection. Every segment
 *   is enqueued (sink feed + onSegment), close drains everything, and the
 *   deferred quota error wins over transcript/handler errors. WeChat quota
 *   semantics are unchanged.
 * - Bridge: direct synchronous `onEvent` emission, no queue, no chains; close
 *   resolves immediately.
 *
 * The streaming state machine (`createStreamingPromptState` +
 * `parseStreamingDataChunk`) was already one shared implementation — only the
 * shell is unified here. This module never resolves commands: lanes pass the
 * final `command`/`args` (the CLI resolves once before delegating).
 */

import type { AgentCommand, PromptUsage } from "./types";
import type { PlanEntry, ToolUseEvent } from "../channels/types.js";
import type { ToolEventMode } from "./tool-event-mode.js";
import { createStreamingPromptState, parseStreamingDataChunk } from "./streaming-prompt";

/** Test-seam child process the flow streams stdout/stderr from. */
export interface StreamingPromptFlowProcess {
  stdout: {
    setEncoding: (encoding: string) => void;
    on: (event: "data", handler: (chunk: string | Buffer) => void) => void;
  };
  stderr: {
    on: (event: "data", handler: (chunk: string | Buffer) => void) => void;
  };
  on: {
    (event: "error", handler: (error: Error) => void): void;
    (event: "close", handler: (code: number | null) => void): void;
  };
}

/** State-machine callbacks. The CLI wraps these in its serialized queue /
 *  chains; the bridge maps them straight onto `onEvent`. */
export interface StreamingPromptFlowHandlers {
  onToolEvent?: (event: ToolUseEvent) => void;
  onThought?: (chunk: string) => void;
  onPlan?: (entries: PlanEntry[]) => void;
  onUsage?: (usage: PromptUsage) => void;
  onCommands?: (commands: AgentCommand[]) => void;
}

/**
 * Delivery strategy. The CLI feeds a quota/verbatim sink (queued) and drains
 * queues + collects handler errors on close; the bridge emits synchronously
 * and finishes trivially. `finish` throws the lane's collected close error, if any.
 */
export interface StreamingPromptFlowEmitter {
  emitSegment(text: string): void;
  finish(): Promise<number>;
}

export interface StreamingPromptFlowOptions {
  command: string;
  args: string[];
  formatToolCalls?: boolean;
  toolEventMode?: ToolEventMode;
  driver?: string;
  rawStream?: boolean;
  spawnPrompt?: (command: string, args: string[]) => StreamingPromptFlowProcess;
  setIntervalFn?: (fn: () => void, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  maxSegmentWaitMs?: number;
  flushCheckIntervalMs?: number;
  now?: () => number;
  handlers?: StreamingPromptFlowHandlers;
  emitter: StreamingPromptFlowEmitter;
}

export interface StreamingPromptFlowResult {
  code: number;
  stdout: string;
  stderr: string;
  overflowCount: number;
}

export async function runStreamingPromptFlow(
  options: StreamingPromptFlowOptions,
): Promise<StreamingPromptFlowResult> {
  const spawnPrompt = options.spawnPrompt;
  if (!spawnPrompt) {
    throw new Error("runStreamingPromptFlow requires a spawnPrompt hook");
  }
  const setIntervalFn = options.setIntervalFn ?? ((fn, delay) => setInterval(fn, delay));
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const rawStream = options.rawStream ?? false;
  // Raw streaming drains the buffer on a tight cadence (~5×/s) for low-latency token
  // streaming; the batched paragraph path keeps the long stall-fallback window.
  const maxSegmentWaitMs = options.maxSegmentWaitMs ?? (rawStream ? 200 : 30_000);
  const flushCheckIntervalMs = options.flushCheckIntervalMs ?? (rawStream ? 80 : 5_000);
  const now = options.now ?? (() => Date.now());
  const handlers = options.handlers ?? {};
  const emitter = options.emitter;

  return await new Promise((resolve, reject) => {
    const child = spawnPrompt(options.command, options.args);
    let stdout = "";
    let stderr = "";
    const toolEventMode: ToolEventMode = options.toolEventMode ?? "text";
    let flushPendingText = () => {};
    const state = createStreamingPromptState(options.formatToolCalls ?? false, {
      mode: toolEventMode,
      ...(options.driver ? { driver: options.driver } : {}),
      rawStream,
      onBeforeActivityEvent: () => {
        flushPendingText();
      },
      ...(handlers.onToolEvent ? { onToolEvent: handlers.onToolEvent } : {}),
      ...(handlers.onThought ? { onThought: handlers.onThought } : {}),
      ...(handlers.onPlan ? { onPlan: handlers.onPlan } : {}),
      ...(handlers.onUsage ? { onUsage: handlers.onUsage } : {}),
      ...(handlers.onCommands ? { onCommands: handlers.onCommands } : {}),
    });
    let lastReplyAt = now();

    const emitSegment = (text: string) => {
      emitter.emitSegment(text);
      lastReplyAt = now();
    };

    const flushBuffer = () => {
      // Raw streaming forwards the buffer verbatim; the batched path trims edges.
      const remaining = rawStream ? state.buffer : state.buffer.trim();
      if (remaining.length > 0) {
        state.buffer = "";
        emitSegment(remaining);
      }
    };

    flushPendingText = () => {
      for (const segment of state.segments.splice(0)) {
        emitSegment(segment);
      }
      flushBuffer();
    };

    // Periodic timer: flush accumulated text if waiting too long
    const timer = setIntervalFn(() => {
      if (state.buffer.trim().length > 0 && now() - lastReplyAt >= maxSegmentWaitMs) {
        flushBuffer();
      }
    }, flushCheckIntervalMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      const text = String(chunk);
      stdout += text;
      parseStreamingDataChunk(state, text);
      for (const segment of state.segments.splice(0)) {
        emitSegment(segment);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearIntervalFn(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearIntervalFn(timer);
      const remaining = state.finalize();
      if (remaining.length > 0) {
        emitSegment(remaining);
      }
      void (async () => {
        const overflowCount = await emitter.finish();
        resolve({ code: code ?? 1, stdout, stderr, overflowCount });
      })().catch((error) => {
        reject(error);
      });
    });
  });
}
