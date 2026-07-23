import type { ToolUseEvent, ToolUseStep } from "./tool-use-types.js";

/**
 * Per-controller accumulator for structured tool events. Each unique
 * `toolCallId` gets a single ToolUseStep that is mutated as later events
 * (start → update → end) for the same id arrive. Steps preserve
 * insertion order so the rendered panel reads top-to-bottom in the
 * order tools were invoked.
 */
export class ToolUseStore {
  private readonly stepsById = new Map<string, ToolUseStep>();
  private readonly order: string[] = [];
  private readonly now: () => number;
  private revision = 0;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  record(event: ToolUseEvent): void {
    const existing = this.stepsById.get(event.toolCallId);
    if (existing) {
      existing.status = event.status;
      if (event.summary !== undefined) existing.summary = event.summary;
      if (event.durationMs !== undefined) {
        existing.durationMs = event.durationMs;
      } else if (event.status !== "running" && existing.durationMs === undefined) {
        existing.durationMs = Math.max(0, this.now() - existing.startedAt);
      }
      // Tool name and kind don't change post-start.
      this.revision += 1;
      return;
    }
    const startedAt = this.now();
    const step: ToolUseStep = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      kind: event.kind,
      ...(event.summary !== undefined ? { summary: event.summary } : {}),
      status: event.status,
      startedAt,
      ...(event.durationMs !== undefined
        ? { durationMs: event.durationMs }
        : event.status !== "running"
          ? { durationMs: 0 }
          : {}),
      // Subagent classification comes from the transport and is fixed at
      // start (like toolName/kind) — carry it through so the panel can fold
      // the delegating parent and indent its children.
      ...(event.isSubagent ? { isSubagent: true } : {}),
      ...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
    };
    this.stepsById.set(event.toolCallId, step);
    this.order.push(event.toolCallId);
    this.revision += 1;
  }

  steps(): ToolUseStep[] {
    return this.order.map((id) => this.stepsById.get(id)!);
  }

  isEmpty(): boolean {
    return this.order.length === 0;
  }

  getRevision(): number {
    return this.revision;
  }
}
