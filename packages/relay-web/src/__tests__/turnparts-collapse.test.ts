import { describe, expect, it, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import TurnParts from "../components/TurnParts.vue";
import MessageList from "../components/MessageList.vue";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../i18n";
import { expandedTraces } from "../lib/trace-expansion";

const tool = (id: string): ToolStepDto => ({
  toolCallId: id,
  toolName: "Read",
  kind: "read",
  status: "success",
  title: `${id}.ts`,
});

const finishedTurn = (): TurnPartDto[] => [
  { type: "reasoning", text: "thinking about it" },
  { type: "tool", step: tool("read-1") },
  { type: "text", text: "first paragraph\n\n" },
  { type: "tool", step: tool("read-2") },
  { type: "reasoning", text: "more thinking" },
  { type: "text", text: "final answer" },
];

async function mountWithLocale(locale: "en" | "zh-CN", props: Record<string, unknown>) {
  i18n.global.locale.value = locale;
  const w = mount(TurnParts, { props: props as never });
  return w;
}

beforeEach(() => {
  setActivePinia(createPinia());
  expandedTraces.clear();
  i18n.global.locale.value = "en";
});

describe("TurnParts trace collapse", () => {
  it("keeps live/default rendering fully inline with no header", () => {
    const w = mount(TurnParts, { props: { parts: finishedTurn(), streaming: true } });
    expect(w.find('[data-test="trace-toggle"]').exists()).toBe(false);
    expect(w.findAll('[data-test="turn-narrative"]').length).toBe(2);
    expect(w.findAll(".shimmer-text, [data-test='tool-step-card']").length).toBeGreaterThan(0);
  });

  it("collapses the entire process and keeps only the trailing final reply", () => {
    const w = mount(TurnParts, {
      props: { parts: finishedTurn(), collapseTrace: true, traceKey: "t:123", traceElapsedMs: 272_000 },
    });
    const header = w.find('[data-test="trace-toggle"]');
    expect(header.exists()).toBe(true);
    expect(header.attributes("aria-expanded")).toBe("false");
    expect(header.text()).toContain("Worked 4m 32s");
    expect(header.text()).toContain("2 tool steps");
    expect(header.text()).toContain("2 thoughts");
    // Process text interleaved before/between activity folds with the trace;
    // only the trailing text after the last process item is the final reply.
    expect(w.findAll('[data-test="turn-narrative"]').map((n) => n.text().trim())).toEqual(["final answer"]);
    expect(w.find('[data-test="tool-step-card"]').exists()).toBe(false);
  });

  it("expands on header click and remembers by traceKey across remounts", async () => {
    const props = { parts: finishedTurn(), collapseTrace: true, traceKey: "t:123" };
    const w = await mountWithLocale("en", props);
    await w.find('[data-test="trace-toggle"]').trigger("click");
    expect(w.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("true");
    expect(w.find('[data-test="tool-step-card"]').exists()).toBe(true);

    // Hub history convergence replaces the row → component rebuilds; the memory is module-level.
    const w2 = mount(TurnParts, { props: props as never });
    expect(w2.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("true");
    expect(w2.find('[data-test="tool-step-card"]').exists()).toBe(true);

    await w2.find('[data-test="trace-toggle"]').trigger("click");
    expect(w2.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("false");
  });

  it("does not share expansion state between different traceKeys", () => {
    const base = { parts: finishedTurn(), collapseTrace: true };
    expandedTraces.add("t:1");
    const w = mount(TurnParts, { props: { ...base, traceKey: "t:2" } as never });
    expect(w.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("false");
  });

  it("omits the header for a pure-text reply", () => {
    const w = mount(TurnParts, {
      props: { parts: [{ type: "text", text: "just an answer" }] as TurnPartDto[], collapseTrace: true, traceKey: "t:9" },
    });
    expect(w.find('[data-test="trace-toggle"]').exists()).toBe(false);
    expect(w.text()).toContain("just an answer");
  });

  it("shows counts only when no elapsed time is available", () => {
    const w = mount(TurnParts, {
      props: { parts: finishedTurn(), collapseTrace: true, traceKey: "t:5", traceElapsedMs: null },
    });
    const header = w.find('[data-test="trace-toggle"]');
    expect(header.text()).not.toContain("Worked");
    expect(header.text()).toContain("2 tool steps");
  });

  it("renders the header in Chinese under the zh-CN locale", async () => {
    const w = await mountWithLocale("zh-CN", {
      parts: finishedTurn(),
      collapseTrace: true,
      traceKey: "t:7",
      traceElapsedMs: 65_000,
    });
    const header = w.find('[data-test="trace-toggle"]');
    expect(header.text()).toContain("已工作 1分5秒");
    expect(header.text()).toContain("2 步工具");
    expect(header.text()).toContain("2 段思考");
  });

  it("collapses anchored agent-message cards as part of the process", async () => {
    // A REAL anchor: the send step carries agentMessageId and the map holds the sent
    // entry, so deriveTurnPresentation actually emits an agent-message item. A mid-turn
    // peer message is process, not the final reply — it folds with the trace and
    // returns on expand.
    const parts: TurnPartDto[] = [
      { type: "tool", step: { ...tool("send-1"), agentMessageId: "m1" } },
      { type: "text", text: "answer" },
    ];
    const w = mount(TurnParts, {
      props: {
        parts,
        collapseTrace: true,
        traceKey: "t:11",
        sentAgentMessages: new Map([["m1", { messageId: "m1", direction: "sent", peer: { handle: "p", displayName: "Peer" }, content: "hi", createdAt: 1 } as never]]),
      },
    });
    expect(w.find('[data-test="turn-agent-message"]').exists()).toBe(false);
    expect(w.findAll('[data-test="turn-narrative"]').map((n) => n.text())).toEqual(["answer"]);

    await w.find('[data-test="trace-toggle"]').trigger("click");
    expect(w.find('[data-test="turn-agent-message"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-message-card"]').text()).toContain("hi");
  });

  it("renders sub-second elapsed as <1s", () => {
    const w = mount(TurnParts, {
      props: { parts: finishedTurn(), collapseTrace: true, traceKey: "t:6", traceElapsedMs: 400 },
    });
    expect(w.find('[data-test="trace-label"]').text()).toContain("Worked <1s");
  });

  it("folds interleaved narrative into the trace and leaves only the final answer", async () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "I'll inspect the implementation.\n\n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "I found the likely cause.\n\n" },
      { type: "reasoning", text: "checking another path" },
      { type: "tool", step: tool("edit-1") },
      { type: "text", text: "Fixed. The issue was caused by X." },
    ];
    const w = mount(TurnParts, {
      props: { parts, collapseTrace: true, traceKey: "t:process-text" },
    });
    expect(w.findAll('[data-test="turn-narrative"]').map((n) => n.text().trim())).toEqual([
      "Fixed. The issue was caused by X.",
    ]);

    // Expanding restores the full interleaved process + final reply in arrival order.
    await w.find('[data-test="trace-toggle"]').trigger("click");
    expect(w.findAll('[data-test="turn-narrative"]').map((n) => n.text().trim())).toEqual([
      "I'll inspect the implementation.",
      "I found the likely cause.",
      "Fixed. The issue was caused by X.",
    ]);
  });

  it("collapses to only the summary header when a turn ends on a process item with no trailing text", () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "running the checks" },
      { type: "tool", step: tool("read-1") },
      { type: "reasoning", text: "verifying" },
    ];
    const w = mount(TurnParts, {
      props: { parts, collapseTrace: true, traceKey: "t:no-trailing" },
    });
    expect(w.find('[data-test="trace-toggle"]').exists()).toBe(true);
    expect(w.find('[data-test="turn-narrative"]').exists()).toBe(false);
    expect(w.find('[data-test="tool-step-card"]').exists()).toBe(false);
  });

  it("keeps reasoning-then-text turns to only the trailing text", () => {
    const w = mount(TurnParts, {
      props: {
        parts: [
          { type: "reasoning", text: "hmm" },
          { type: "tool", step: tool("read-1") },
          { type: "text", text: "final only" },
        ] as TurnPartDto[],
        collapseTrace: true,
        traceKey: "t:reasoning-first",
      },
    });
    expect(w.findAll('[data-test="turn-narrative"]').map((n) => n.text().trim())).toEqual(["final only"]);
  });
});

describe("MessageList convergence", () => {
  const parts: TurnPartDto[] = [{ type: "tool", step: tool("read-1") }, { type: "text", text: "done" }];
  const STARTED = 1_757_000_000_000;
  const optimistic = {
    instanceId: "i1", sessionAlias: "s1", direction: "out" as const, text: "reply",
    createdAt: "2026-09-07T10:00:30.000Z", startedAt: STARTED, structured: { parts },
  };

  it("keeps a manual expansion across hub history convergence (optimistic → persisted row)", async () => {
    const w = mount(MessageList, { props: { messages: [optimistic as never], liveTurn: null } });
    expect(w.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("false");
    await w.find('[data-test="trace-toggle"]').trigger("click");
    expect(w.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("true");

    // Convergence replaces the optimistic row with the persisted one (new object
    // identity → TurnParts rebuilds). startedAt is the stable key (hub broadcasts it
    // on turn-started, so optimistic and persisted rows carry the identical hub timestamp),
    // and the manual expansion survives.
    await w.setProps({ messages: [{ ...optimistic, id: 7 } as never] });
    expect(w.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("true");
    expect(w.find('[data-test="tool-step-card"]').exists()).toBe(true);
  });

  it("never collapses a failed turn after convergence (persisted turnStatus = error, no local failed flag)", () => {
    const failedRow = { ...optimistic, id: 8, structured: { parts, turnStatus: "error" as const } };
    const w = mount(MessageList, { props: { messages: [failedRow as never], liveTurn: null } });
    // The optimistic `failed` flag is gone; only the hub-stamped terminal status
    // says this turn failed — its trace must stay inline.
    expect(w.find('[data-test="trace-toggle"]').exists()).toBe(false);
    expect(w.find('[data-test="tool-step-card"]').exists()).toBe(true);
  });

  it("collapses a converged done row (persisted turnStatus = done)", () => {
    const doneRow = { ...optimistic, id: 9, structured: { parts, turnStatus: "done" as const } };
    const w = mount(MessageList, { props: { messages: [doneRow as never], liveTurn: null } });
    expect(w.find('[data-test="trace-toggle"]').exists()).toBe(true);
    expect(w.find('[data-test="tool-step-card"]').exists()).toBe(false);
  });
});

describe("MessageList collapse policy", () => {
  const base = { instanceId: "i1", sessionAlias: "s1", direction: "out" as const, text: "reply" };

  it("passes collapse props on done rows and withholds them on failed rows", () => {
    const mk = (extra: Record<string, unknown>) => ({
      ...base,
      createdAt: "2026-09-07T10:00:00.000Z",
      ...extra,
    });
    const parts: TurnPartDto[] = [{ type: "tool", step: tool("read-1") }, { type: "text", text: "done" }];
    const w = mount(MessageList, {
      props: {
        messages: [
          mk({ id: 7, startedAt: Date.parse("2026-09-07T09:59:30.000Z"), structured: { parts } }),
          mk({ id: 8, startedAt: Date.parse("2026-09-07T09:59:30.000Z"), structured: { parts }, failed: true }),
        ],
        liveTurn: null,
      },
    });
    const headers = w.findAll('[data-test="trace-toggle"]');
    expect(headers.length).toBe(1);
    expect(headers[0]!.attributes("aria-expanded")).toBe("false");
    expect(headers[0]!.text()).toContain("Worked 30s");
    // The failed row renders its trace inline (error must stay unmissable).
    expect(w.findAll('[data-test="tool-step-card"]').length).toBe(1);
  });
});
