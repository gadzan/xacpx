import { expect, test } from "bun:test";

import { buildXacpxMcpToolRegistry } from "../../../src/mcp/xacpx-mcp-tools";
import { createMemoryTransport } from "../../../src/mcp/xacpx-mcp-transport";
import type { OrchestrationTaskRecord } from "../../../src/orchestration/orchestration-types";
import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";
import { QuotaDeferredError } from "../../../src/weixin/messaging/quota-errors";

function makeTaskRecord(overrides: Partial<OrchestrationTaskRecord> = {}): OrchestrationTaskRecord {
  return {
    taskId: "task-1",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the module",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:01.000Z",
    ...overrides,
  };
}

test("builds 13 MCP tools and appends messaging tools after orchestration tools", async () => {
  const calls: unknown[] = [];
  const transport = createMemoryTransport(
    async (input) => {
      calls.push(input);
      return { taskId: "task-9", status: "needs_confirmation" };
    },
    {
      getTask: async () => null,
      listTasks: async () => [],
      approveTask: async () => {
        throw new Error("approve not implemented");
      },
      cancelTask: async () => {
        throw new Error("cancel not implemented");
      },
      workerRaiseQuestion: async (input) => {
        calls.push(input);
        return { taskId: "task-1", questionId: "question-1", status: "blocked" };
      },
    },
  );

  const registry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
  });

  expect(registry).toHaveLength(13);
  expect(registry.map((tool) => tool.name)).toEqual([
    "delegate_request",
    "delegate_batch",
    "task_get",
    "task_list",
    "task_approve",
    "task_cancel",
    "task_watch",
    "worker_raise_question",
    "coordinator_answer_question",
    "coordinator_request_human_input",
    "coordinator_review_contested_result",
    "agent_list",
    "agent_send",
  ]);

  const delegateTool = registry.find((tool) => tool.name === "delegate_request");
  expect(delegateTool).toBeDefined();
  expect(delegateTool?.description).toContain("workingDirectory");
  expect(
    delegateTool?.inputSchema.safeParse({
      sourceHandle: "spoofed",
      targetAgent: "claude",
      task: "review",
    }).success,
  ).toBe(false);
  expect(
    delegateTool?.inputSchema.safeParse({
      coordinatorSession: "spoofed",
      targetAgent: "claude",
      task: "review",
      workingDirectory: "/repo/weacpx",
    }).success,
  ).toBe(false);
  const workerRaiseQuestionTool = registry.find((tool) => tool.name === "worker_raise_question");
  expect(workerRaiseQuestionTool).toBeDefined();
  expect(
    workerRaiseQuestionTool?.inputSchema.safeParse({
      coordinatorSession: "spoofed",
      sourceHandle: "spoofed",
      taskId: "task-1",
      question: "Need environment details",
      whyBlocked: "Requirement is ambiguous",
      whatIsNeeded: "Clarify the target environment",
    }).success,
  ).toBe(false);
  const taskListTool = registry.find((tool) => tool.name === "task_list");
  expect(taskListTool).toBeDefined();
  expect(taskListTool?.inputSchema.safeParse({ status: "blocked" }).success).toBe(true);
  expect(taskListTool?.inputSchema.safeParse({ status: "waiting_for_human" }).success).toBe(true);
  const response = await delegateTool?.handler({
    targetAgent: "claude",
    task: "review",
    workingDirectory: "/repo/weacpx",
    role: "reviewer",
  });
  const workerResponse = await workerRaiseQuestionTool?.handler({
    taskId: "task-1",
    question: "Need environment details",
    whyBlocked: "Requirement is ambiguous",
    whatIsNeeded: "Clarify the target environment",
  });

  expect(calls).toEqual([
    {
      coordinatorSession: "backend:main",
      sourceHandle: "backend:worker",
      targetAgent: "claude",
      task: "review",
      workingDirectory: "/repo/weacpx",
      role: "reviewer",
    },
    {
      sourceHandle: "backend:worker",
      taskId: "task-1",
      question: "Need environment details",
      whyBlocked: "Requirement is ambiguous",
      whatIsNeeded: "Clarify the target environment",
    },
  ]);
  expect(response).toEqual({
    content: [
      {
        type: "text",
        text:
          "Delegation task \"task-9\" created.\n- Status: needs_confirmation\n"
          + "Next: this delegation requires user approval. "
          + "Tell the user, then call task_approve or task_cancel based on their response.",
      },
    ],
    structuredContent: { taskId: "task-9", status: "needs_confirmation" },
  });
  expect(workerResponse).toEqual({
    content: [{ type: "text", text: "Blocker question submitted for task \"task-1\".\n- questionId: question-1" }],
    structuredContent: { taskId: "task-1", questionId: "question-1", status: "blocked" },
  });
});

test("registers scheduled_create only for internal non-worker session tools", async () => {
  const scheduledCalls: unknown[] = [];
  const transport = createMemoryTransport(
    async () => ({ taskId: "task-1", status: "needs_confirmation" }),
    {
      scheduledCreate: async (input) => {
        scheduledCalls.push(input);
        return {
          id: "k8f2",
          chat_key: "wx:user",
          session_alias: "main",
          session_mode: "temp",
          execute_at: "2026-05-25T02:00:00.000Z",
          message: "检查 CI",
          status: "pending",
          created_at: "2026-05-25T00:00:00.000Z",
        };
      },
    },
  );

  const registry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "backend:main",
    internalSessionTools: true,
  });
  const workerRegistry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
    internalSessionTools: true,
  });
  const externalRegistry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "external_codex:backend",
    isExternalCoordinator: true,
    internalSessionTools: true,
  });

  expect(registry.map((tool) => tool.name)).toContain("scheduled_create");
  expect(workerRegistry.map((tool) => tool.name)).not.toContain("scheduled_create");
  expect(externalRegistry.map((tool) => tool.name)).not.toContain("scheduled_create");

  const scheduledCreate = registry.find((tool) => tool.name === "scheduled_create");
  expect(scheduledCreate).toBeDefined();
  expect(
    scheduledCreate?.inputSchema.safeParse({
      timeText: "in 2h",
      message: "检查 CI",
      chatKey: "wx:user",
    }).success,
  ).toBe(false);
  expect(
    scheduledCreate?.inputSchema.safeParse({
      timeText: "in 2h",
      message: "检查 CI",
      sessionAlias: "main",
    }).success,
  ).toBe(false);

  const result = await scheduledCreate?.handler({
    timeText: "in 2h",
    message: "检查 CI",
    mode: "temp",
  });

  expect(scheduledCalls).toEqual([
    {
      coordinatorSession: "backend:main",
      timeText: "in 2h",
      message: "检查 CI",
      mode: "temp",
    },
  ]);
  expect(result).toEqual({
    content: [
      {
        type: "text",
        text: "Scheduled task #k8f2 created for 2026-05-25T02:00:00.000Z.",
      },
    ],
    structuredContent: {
      id: "k8f2",
      status: "pending",
      executeAt: "2026-05-25T02:00:00.000Z",
      sessionAlias: "main",
      sessionMode: "temp",
    },
  });
});

test("registers scheduled_list and scheduled_cancel only for internal non-worker session tools", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const transport = createMemoryTransport(
    async () => ({ taskId: "task-1", status: "needs_confirmation" }),
    {
      scheduledList: async (input) => {
        calls.push({ method: "scheduledList", input });
        return [
          {
            id: "k8f2",
            chat_key: "wx:user",
            session_alias: "main",
            session_mode: "temp",
            execute_at: "2026-05-25T02:00:00.000Z",
            message: "检查 CI",
            status: "pending",
            created_at: "2026-05-25T00:00:00.000Z",
          },
        ];
      },
      scheduledCancel: async (input) => {
        calls.push({ method: "scheduledCancel", input });
        return { id: "k8f2", cancelled: true };
      },
    },
  );

  const registry = buildXacpxMcpToolRegistry({ transport, coordinatorSession: "backend:main", internalSessionTools: true });
  const workerRegistry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
    internalSessionTools: true,
  });
  const externalRegistry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "external_codex:backend",
    isExternalCoordinator: true,
    internalSessionTools: true,
  });
  const offRegistry = buildXacpxMcpToolRegistry({ transport, coordinatorSession: "backend:main" });

  for (const name of ["scheduled_list", "scheduled_cancel"]) {
    expect(registry.map((tool) => tool.name)).toContain(name);
    expect(workerRegistry.map((tool) => tool.name)).not.toContain(name);
    expect(externalRegistry.map((tool) => tool.name)).not.toContain(name);
    expect(offRegistry.map((tool) => tool.name)).not.toContain(name);
  }

  const listTool = registry.find((tool) => tool.name === "scheduled_list");
  const listResult = await listTool?.handler({});
  expect(calls).toContainEqual({ method: "scheduledList", input: { coordinatorSession: "backend:main" } });
  expect(listResult).toEqual({
    content: [
      {
        type: "text",
        text: "Pending scheduled tasks:\n- #k8f2 at 2026-05-25T02:00:00.000Z [temp] -> main: 检查 CI",
      },
    ],
    structuredContent: {
      tasks: [
        {
          id: "k8f2",
          executeAt: "2026-05-25T02:00:00.000Z",
          message: "检查 CI",
          sessionAlias: "main",
          sessionMode: "temp",
          chatKey: "wx:user",
        },
      ],
    },
  });

  const cancelTool = registry.find((tool) => tool.name === "scheduled_cancel");
  // The leading # and case are passed through verbatim; normalization happens in the resolver.
  const cancelResult = await cancelTool?.handler({ id: "#K8F2" });
  expect(calls).toContainEqual({ method: "scheduledCancel", input: { coordinatorSession: "backend:main", id: "#K8F2" } });
  expect(cancelResult).toEqual({
    content: [{ type: "text", text: "Scheduled task #k8f2 cancelled." }],
    structuredContent: { id: "k8f2", cancelled: true },
  });
});

test("worker_raise_question fails clearly when no host sourceHandle is bound", async () => {
  const calls: unknown[] = [];
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("approve not implemented");
        },
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
        workerRaiseQuestion: async (input) => {
          calls.push(input);
          return { taskId: "task-1", questionId: "question-1", status: "blocked" };
        },
      },
    ),
    coordinatorSession: "backend:main",
  });

  const workerRaiseQuestionTool = registry.find((tool) => tool.name === "worker_raise_question");
  const result = await workerRaiseQuestionTool?.handler({
    taskId: "task-1",
    question: "Need environment details",
    whyBlocked: "Requirement is ambiguous",
    whatIsNeeded: "Clarify the target environment",
  });

  expect(calls).toEqual([]);
  expect(result).toEqual({
    isError: true,
    content: [
      {
        type: "text",
        text: "worker_raise_question requires a bound sourceHandle; start mcp-stdio with --source-handle or XACPX_SOURCE_HANDLE",
      },
    ],
  });
});

test("QuotaDeferredError from coordinator_request_human_input becomes a soft deferred_quota result", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("approve not implemented");
        },
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
        coordinatorRequestHumanInput: async () => {
          throw new QuotaDeferredError({ chatKey: "wx:user-deferred", reason: "exhausted" });
        },
      },
    ),
    coordinatorSession: "backend:main",
  });

  const requestTool = registry.find((tool) => tool.name === "coordinator_request_human_input");
  const requestResult = await requestTool?.handler({
    taskQuestions: [{ taskId: "task-1", questionId: "q-1" }],
    promptText: "需要您的判断",
  });

  expect(requestResult?.isError).toBe(false);
  // chatKey is an internal weixin routing identifier and intentionally not
  // surfaced to MCP hosts; only the deferred_quota status is exposed.
  expect(requestResult?.structuredContent).toEqual({
    status: "deferred_quota",
  });
  expect(requestResult?.content[0]).toMatchObject({ type: "text" });
  expect((requestResult?.content[0] as { text: string }).text).toContain("Outbound budget exhausted");
});

test("generic Error remains a hard error result (backward compatible)", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => {
        throw new Error("rpc blew up");
      },
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("approve not implemented");
        },
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
  });

  const delegateTool = registry.find((tool) => tool.name === "delegate_request");
  const result = await delegateTool?.handler({
    targetAgent: "claude",
    task: "review",
  });

  expect(result?.isError).toBe(true);
  expect((result?.content[0] as { text: string }).text).toContain("rpc blew up");
});

test("task_get renders not-found as text plus structured null wrapper", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("approve not implemented");
        },
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
      },
    ),
    coordinatorSession: "backend:main",
  });

  const taskGet = registry.find((tool) => tool.name === "task_get");
  const result = await taskGet?.handler({ taskId: "task-missing" });

  expect(result).toEqual({
    content: [{ type: "text", text: "Task not found." }],
    structuredContent: { task: null },
  });
});

test("task_get omits the delegated prompt by default but keeps it for needs_confirmation / includePrompt", async () => {
  const longPrompt = "PROMPT-LINE-".repeat(40);
  const getText = async (task: OrchestrationTaskRecord, args: Record<string, unknown>) => {
    const registry = buildXacpxMcpToolRegistry({
      transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "running" }), {
        getTask: async () => task,
      }),
      coordinatorSession: "backend:main",
    });
    const tool = registry.find((entry) => entry.name === "task_get");
    return ((await tool?.handler(args))?.content[0] as { text: string }).text;
  };

  // Terminal task: the coordinator wrote the prompt, so we echo the result, not the prompt.
  const terminal = await getText(
    makeTaskRecord({ status: "completed", task: longPrompt, summary: "done", resultText: "FINAL-OUTPUT" }),
    { taskId: "task-1" },
  );
  expect(terminal).not.toContain(longPrompt);
  expect(terminal).toContain("- Result: FINAL-OUTPUT");

  // needs_confirmation: the approver must see exactly what will run.
  const confirm = await getText(
    makeTaskRecord({ status: "needs_confirmation", task: longPrompt }),
    { taskId: "task-1" },
  );
  expect(confirm).toContain(`- Task: ${longPrompt}`);

  // includePrompt: explicit opt-in to re-read the prompt for any status.
  const withPrompt = await getText(
    makeTaskRecord({ status: "running", task: longPrompt }),
    { taskId: "task-1", includePrompt: true },
  );
  expect(withPrompt).toContain(`- Task: ${longPrompt}`);
});

test("task_watch surfaces the result on a terminal stop instead of pointing at task_get", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "running" }), {
      watchTask: async () => ({
        status: "terminal" as const,
        task: makeTaskRecord({ status: "completed", summary: "done", resultText: "ALL-DONE" }),
        events: [
          { seq: 2, at: "2026-05-16T00:00:05.000Z", type: "status_changed", status: "completed", message: "Task completed" },
        ],
        nextAfterSeq: 2,
      }),
    }),
    coordinatorSession: "backend:main",
  });

  const watch = registry.find((entry) => entry.name === "task_watch");
  const text = ((await watch?.handler({ taskId: "task-1" }))?.content[0] as { text: string }).text;

  expect(text).toContain("- Result: ALL-DONE");
  expect(text).toContain("Next: summarize this result for the user.");
  expect(text).not.toContain("task_get");
});

test("task_watch falls back to the summary on a terminal stop with no result text", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "running" }), {
      watchTask: async () => ({
        status: "terminal" as const,
        task: makeTaskRecord({ status: "cancelled", summary: "cancelled before output", resultText: "" }),
        events: [
          { seq: 2, at: "2026-05-16T00:00:05.000Z", type: "status_changed", status: "cancelled", message: "Task cancelled" },
        ],
        nextAfterSeq: 2,
      }),
    }),
    coordinatorSession: "backend:main",
  });

  const watch = registry.find((entry) => entry.name === "task_watch");
  const text = ((await watch?.handler({ taskId: "task-1" }))?.content[0] as { text: string }).text;

  expect(text).toContain("- Summary: cancelled before output");
  expect(text).not.toContain("- Result:");
  expect(text).toContain("Next: summarize this result for the user.");
});

test("task_watch surfaces the open question on an attention stop", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "running" }), {
      watchTask: async () => ({
        status: "attention_required" as const,
        task: makeTaskRecord({
          status: "blocked",
          summary: "needs input",
          openQuestion: {
            questionId: "q-1",
            question: "Which branch should I target?",
            whyBlocked: "ambiguous",
            whatIsNeeded: "branch name",
            askedAt: "2026-05-16T00:00:03.000Z",
            status: "open",
          },
        }),
        events: [
          { seq: 3, at: "2026-05-16T00:00:03.000Z", type: "attention_required", status: "blocked", message: "Which branch?" },
        ],
        nextAfterSeq: 3,
      }),
    }),
    coordinatorSession: "backend:main",
  });

  const watch = registry.find((entry) => entry.name === "task_watch");
  const text = ((await watch?.handler({ taskId: "task-1" }))?.content[0] as { text: string }).text;

  expect(text).toContain("- Open question: Which branch should I target?");
  expect(text).toContain("coordinator_answer_question");
});

test("delegate_request running result appends a non-blocking Next hint", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-running", status: "running" }),
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("approve not implemented");
        },
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
  });

  const delegate = registry.find((tool) => tool.name === "delegate_request");
  const result = await delegate?.handler({
    targetAgent: "opencode",
    task: "introduce yourself",
    workingDirectory: "/repo",
  });

  const text = (result?.content[0] as { text: string }).text;
  expect(text).toContain("Delegation task \"task-running\" created.");
  expect(text).toContain("- Status: running");
  expect(text).toContain("Next: task \"task-running\" is running.");
  expect(text).toContain("Return this taskId to the user");
  expect(text).toContain("call task_watch to long-poll until it finishes");
  expect(text).toContain("the terminal watch carries the worker's result");
  expect(text).toContain("no follow-up task_get is needed");
  expect(text).not.toContain("non-blocking progress snapshots");
});

test("task_watch description states the native watcher is single-shot", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "running" })),
    coordinatorSession: "backend:main",
  });
  const taskWatch = registry.find((tool) => tool.name === "task_watch");
  expect(taskWatch?.description).toContain("single-shot");
  expect(taskWatch?.description).toContain("afterSeq set to the returned nextAfterSeq");
});

test("tool descriptions reference the next step in the lifecycle", () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("approve not implemented");
        },
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
  });
  const byName = new Map(registry.map((tool) => [tool.name, tool]));

  expect(byName.get("delegate_request")?.description).toContain("Delegate a subtask");
  expect(byName.get("delegate_request")?.description).toContain("Supports MCP Tasks");
  expect(byName.get("task_watch")?.description).toContain("Long-poll a task");
  expect(byName.get("task_watch")?.description).toContain("single-shot");
  expect(byName.get("task_get")?.description).toContain("recover a task you lost track of");
  expect(byName.get("task_get")?.description).toContain("includePrompt:true");
  expect(byName.get("task_approve")?.description).toContain("needs_confirmation");
  expect(byName.get("coordinator_answer_question")?.description).toContain("task_get shows a pending question");
  expect(byName.get("worker_raise_question")?.description).toContain("Worker-side only");
});

test("task_approve result text points the coordinator back to task_watch", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => ({ taskId: "task-approved", status: "running" }),
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
      },
    ),
    coordinatorSession: "backend:main",
  });

  const approveTool = registry.find((tool) => tool.name === "task_approve");
  const text = (
    (await approveTool?.handler({ taskId: "task-approved" }))?.content[0] as { text: string }
  ).text;

  expect(text).toContain("Task \"task-approved\" approved.");
  expect(text).toContain("- Current status: running");
  expect(text).toContain("Next: call task_watch to long-poll until the worker finishes");
  expect(text).toContain("the terminal watch returns the result directly");
  expect(text).not.toContain("non-blocking progress snapshots");
});

test("registry hides human-input package tools when the coordinator is external", () => {
  const transport = createMemoryTransport(
    async () => ({ taskId: "task-1", status: "running" }),
    {
      getTask: async () => null,
      listTasks: async () => [],
      approveTask: async () => {
        throw new Error("approve not implemented");
      },
      cancelTask: async () => {
        throw new Error("cancel not implemented");
      },
    },
  );

  const externalRegistry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "external_claude-code:backend",
    isExternalCoordinator: true,
  });
  const externalNames = externalRegistry.map((tool) => tool.name);
  // coordinator_request_human_input hard-throws "human input routing is not configured for
  // external coordinator" in orchestration-service.ts. Don't advertise dead tools.
  expect(externalNames).not.toContain("coordinator_request_human_input");
  // Other coordinator-side tools must remain available — answering questions, reviewing
  // contested results, approving / rejecting / cancelling all work for external coordinators.
  expect(externalNames).toContain("delegate_request");
  expect(externalNames).toContain("task_watch");
  expect(externalNames).toContain("coordinator_answer_question");
  expect(externalNames).toContain("coordinator_review_contested_result");
  expect(externalNames).toContain("agent_list");
  expect(externalNames).toContain("agent_send");
  expect(externalRegistry).toHaveLength(12);

  const internalRegistry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "backend:main",
  });
  expect(internalRegistry).toHaveLength(13);
  expect(internalRegistry.map((tool) => tool.name)).toContain("coordinator_request_human_input");
});

test("delegate_batch creates one group and delegates every task into it", async () => {
  const calls: unknown[] = [];
  let groupSeq = 0;
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async (input) => {
        calls.push({ method: "delegateRequest", input });
        return { taskId: `task-${calls.length}`, status: "running" as const };
      },
      {
        createGroup: async (input) => {
          calls.push({ method: "createGroup", input });
          groupSeq += 1;
          return {
            groupId: `group-${groupSeq}`,
            coordinatorSession: "backend:main",
            title: (input as { title: string }).title,
            createdAt: "2026-05-18T00:00:00.000Z",
            updatedAt: "2026-05-18T00:00:00.000Z",
          };
        },
      },
    ),
    coordinatorSession: "backend:main",
  });

  const tool = registry.find((entry) => entry.name === "delegate_batch");
  expect(tool).toBeDefined();

  const result = await tool!.handler({
    tasks: [
      { targetAgent: "claude", task: "review module A" },
      { targetAgent: "codex", task: "review module B" },
    ],
  });

  expect(calls).toEqual([
    { method: "createGroup", input: { coordinatorSession: "backend:main", title: "Batch delegation (2 tasks)" } },
    { method: "delegateRequest", input: { coordinatorSession: "backend:main", targetAgent: "claude", task: "review module A", groupId: "group-1" } },
    { method: "delegateRequest", input: { coordinatorSession: "backend:main", targetAgent: "codex", task: "review module B", groupId: "group-1" } },
  ]);
  expect(result.structuredContent).toEqual({
    groupId: "group-1",
    tasks: [
      { index: 0, taskId: "task-2", status: "running" },
      { index: 1, taskId: "task-3", status: "running" },
    ],
  });
});

test("delegate_batch with a single task skips group creation", async () => {
  const calls: unknown[] = [];
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(async (input) => {
      calls.push({ method: "delegateRequest", input });
      return { taskId: "task-1", status: "running" as const };
    }),
    coordinatorSession: "backend:main",
  });

  const tool = registry.find((entry) => entry.name === "delegate_batch");
  await tool!.handler({ tasks: [{ targetAgent: "claude", task: "solo task" }] });

  expect(calls).toEqual([
    { method: "delegateRequest", input: { coordinatorSession: "backend:main", targetAgent: "claude", task: "solo task" } },
  ]);
});

test("delegate_batch passes an explicit title to createGroup verbatim", async () => {
  const createGroupCalls: unknown[] = [];
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" as const }),
      {
        createGroup: async (input) => {
          createGroupCalls.push(input);
          return {
            groupId: "group-title-test",
            coordinatorSession: "backend:main",
            title: (input as { title: string }).title,
            createdAt: "2026-05-18T00:00:00.000Z",
            updatedAt: "2026-05-18T00:00:00.000Z",
          };
        },
      },
    ),
    coordinatorSession: "backend:main",
  });

  const tool = registry.find((entry) => entry.name === "delegate_batch");
  await tool!.handler({
    title: "My custom batch title",
    tasks: [
      { targetAgent: "claude", task: "task A" },
      { targetAgent: "codex", task: "task B" },
    ],
  });

  expect(createGroupCalls).toEqual([
    { coordinatorSession: "backend:main", title: "My custom batch title" },
  ]);
});

test("delegate_batch reports a per-task error without aborting the rest of the batch", async () => {
  let n = 0;
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => {
        n += 1;
        if (n === 2) throw new Error("unknown agent");
        return { taskId: `task-${n}`, status: "running" as const };
      },
      {
        createGroup: async () => ({
          groupId: "group-1",
          coordinatorSession: "backend:main",
          title: "Batch delegation (3 tasks)",
          createdAt: "2026-05-18T00:00:00.000Z",
          updatedAt: "2026-05-18T00:00:00.000Z",
        }),
      },
    ),
    coordinatorSession: "backend:main",
  });

  const tool = registry.find((entry) => entry.name === "delegate_batch");
  const result = await tool!.handler({
    tasks: [
      { targetAgent: "claude", task: "a" },
      { targetAgent: "bogus", task: "b" },
      { targetAgent: "codex", task: "c" },
    ],
  });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toEqual({
    groupId: "group-1",
    tasks: [
      { index: 0, taskId: "task-1", status: "running" },
      { index: 1, error: "unknown agent" },
      { index: 2, taskId: "task-3", status: "running" },
    ],
  });
});

test("delegate_request forwards parallel:true to the transport", async () => {
  const capturedInputs: unknown[] = [];
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async (input) => {
        capturedInputs.push(input);
        return { taskId: "task-parallel", status: "running" as const };
      },
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("approve not implemented");
        },
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
  });

  const delegateTool = registry.find((tool) => tool.name === "delegate_request")!;
  // Schema must accept parallel:true (strict schema would reject unknown keys before the fix)
  const parseResult = delegateTool.inputSchema.safeParse({
    targetAgent: "claude",
    task: "do the thing",
    parallel: true,
  });
  expect(parseResult.success).toBe(true);

  await delegateTool.handler({
    targetAgent: "claude",
    task: "do the thing",
    parallel: true,
  });

  expect(capturedInputs).toHaveLength(1);
  expect((capturedInputs[0] as Record<string, unknown>).parallel).toBe(true);
});

test("delegate_request omits parallel when not provided", async () => {
  const capturedInputs: unknown[] = [];
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async (input) => {
        capturedInputs.push(input);
        return { taskId: "task-no-parallel", status: "running" as const };
      },
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("approve not implemented");
        },
        cancelTask: async () => {
          throw new Error("cancel not implemented");
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
  });

  const delegateTool = registry.find((tool) => tool.name === "delegate_request")!;
  await delegateTool.handler({
    targetAgent: "claude",
    task: "do the other thing",
  });

  expect(capturedInputs).toHaveLength(1);
  expect("parallel" in (capturedInputs[0] as Record<string, unknown>)).toBe(false);
});

test("delegate_batch forwards per-task parallel and omits it when not provided", async () => {
  const calls: unknown[] = [];
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async (input) => {
        calls.push({ method: "delegateRequest", input });
        return { taskId: `task-${calls.length}`, status: "running" as const };
      },
      {
        createGroup: async () => ({
          groupId: "group-1",
          coordinatorSession: "backend:main",
          title: "Batch delegation (2 tasks)",
          createdAt: "2026-05-18T00:00:00.000Z",
          updatedAt: "2026-05-18T00:00:00.000Z",
        }),
      },
    ),
    coordinatorSession: "backend:main",
  });

  const tool = registry.find((entry) => entry.name === "delegate_batch");
  await tool!.handler({
    tasks: [
      { targetAgent: "claude", task: "review module A", parallel: true },
      { targetAgent: "codex", task: "review module B" },
    ],
  });

  expect(calls).toEqual([
    { method: "delegateRequest", input: { coordinatorSession: "backend:main", targetAgent: "claude", task: "review module A", groupId: "group-1", parallel: true } },
    { method: "delegateRequest", input: { coordinatorSession: "backend:main", targetAgent: "codex", task: "review module B", groupId: "group-1" } },
  ]);
});

test("agent messaging tools use strict public schemas and inject the bound sender identity", async () => {
  const calls: unknown[] = [];
  const agents = [
    {
      address: { nodeId: "node-local", endpointId: "endpoint-peer" },
      handle: "agent:node-local:endpoint-peer",
      node: "node-local",
      agent: "codex",
      workspace: "backend",
      displayName: "reviewer",
      state: "running" as const,
      activity: { status: "working" as const, summary: "Reviewing auth migration" },
      capabilities: { receive: true, steer: false, queue: true, interrupt: false, conversation: true },
    },
  ];
  const receipt = {
    messageId: "msg-1",
    status: "queued" as const,
    modeUsed: "queue" as const,
    route: "local" as const,
  };
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        listAgentEndpoints: async (input) => {
          calls.push(input);
          return agents;
        },
        sendAgentMessage: async (input) => {
          calls.push(input);
          return receipt;
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker-a",
  });

  const listTool = registry.find((tool) => tool.name === "agent_list");
  const sendTool = registry.find((tool) => tool.name === "agent_send");
  expect(listTool).toBeDefined();
  expect(sendTool).toBeDefined();
  expect(listTool?.inputSchema.safeParse({}).success).toBe(true);
  expect(listTool?.inputSchema.safeParse({ scope: "all" }).success).toBe(false);
  expect(
    sendTool?.inputSchema.safeParse({
      to: "agent:node-local:endpoint-peer",
      message: "schema changed",
      mode: "auto",
      replyTo: "msg-prior",
    }).success,
  ).toBe(true);
  for (const forbidden of ["from", "coordinatorSession", "sourceHandle"]) {
    expect(
      sendTool?.inputSchema.safeParse({
        to: "agent:node-local:endpoint-peer",
        message: "schema changed",
        [forbidden]: "spoofed",
      }).success,
    ).toBe(false);
  }

  const listResult = await listTool?.handler({});
  const sendResult = await sendTool?.handler({
    to: "agent:node-local:endpoint-peer",
    message: "schema changed",
    mode: "auto",
    replyTo: "msg-prior",
  });

  expect(listResult?.structuredContent).toEqual({ agents });
  expect(sendResult?.structuredContent).toEqual(receipt);
  expect(sendResult?.content[0]).toMatchObject({ type: "text" });
  expect(calls).toEqual([
    { coordinatorSession: "backend:main", sourceHandle: "backend:worker-a" },
    {
      coordinatorSession: "backend:main",
      sourceHandle: "backend:worker-a",
      to: "agent:node-local:endpoint-peer",
      message: "schema changed",
      mode: "auto",
      replyTo: "msg-prior",
    },
  ]);
});

test("agent_send preserves typed messaging failures in structured and human-readable results", async () => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        sendAgentMessage: async () => {
          throw new AgentMessagingError("TARGET_NOT_REACHABLE", "Target is not reachable.");
        },
      },
    ),
    coordinatorSession: "backend:main",
  });

  const result = await registry.find((tool) => tool.name === "agent_send")?.handler({
    to: "agent:node-local:endpoint-peer",
    message: "schema changed",
  });

  expect(result).toEqual({
    content: [{ type: "text", text: "Target is not reachable." }],
    structuredContent: {
      error: {
        code: "TARGET_NOT_REACHABLE",
        message: "Target is not reachable.",
      },
    },
    isError: true,
  });
});

test.each([
  ["TARGET_NOT_RUNNING", "Target has no active turn."],
  ["DELIVERY_RACE", "The active turn changed before delivery."],
] as const)("agent_send preserves %s as a structured messaging failure", async (code, message) => {
  const registry = buildXacpxMcpToolRegistry({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        sendAgentMessage: async () => {
          throw new AgentMessagingError(code, message);
        },
      },
    ),
    coordinatorSession: "backend:main",
  });

  const result = await registry.find((tool) => tool.name === "agent_send")?.handler({
    to: "agent:node-local:endpoint-peer",
    message: "schema changed",
  });

  expect(result).toEqual({
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code, message } },
    isError: true,
  });
});
