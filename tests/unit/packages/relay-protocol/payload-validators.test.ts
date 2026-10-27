// tests/unit/packages/relay-protocol/payload-validators.test.ts
import { expect, test } from "bun:test";
import {
  MSG,
  parseControlPayload,
  parseJevSettings,
  parseJevTestResult,
  parseRouterAvailability,
  parseTerminalEventPayload,
  CONTROL_PAYLOAD_VALIDATORS,
} from "../../../../packages/relay-protocol/src/index";

test("policy RPC accepts requests, never trusted proof, and keeps the legacy RPC distinct", () => {
  const base = { conversationId: "c", topicId: "t", requestId: "r", text: "review" };
  const policies = [{ botId: "a", filesystem: "read-only" }, { botId: "b", filesystem: "read-write" }];
  expect(MSG.conversationPromptWithPolicy).not.toBe(MSG.conversationPrompt);
  expect(parseControlPayload(MSG.conversationPromptWithPolicy, { ...base, memberPolicies: policies })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPromptWithPolicy, base)).toBeNull();
  for (const memberPolicies of [[], null, [{ botId: "a", filesystem: "unknown" }], [...policies, policies[0]],
    [{ ...policies[0], effectProvenance: "declared-enforced" }], [{ ...policies[0], trustedReadOnly: true }]]) {
    expect(parseControlPayload(MSG.conversationPromptWithPolicy, { ...base, memberPolicies })).toBeNull();
  }
  for (const forged of [{ effectProvenance: "declared-enforced" }, { trustedReadOnly: true }, { effect: "read-only" }]) {
    expect(parseControlPayload(MSG.conversationPromptWithPolicy, { ...base, memberPolicies: policies, ...forged })).toBeNull();
  }
  expect(parseControlPayload(MSG.conversationPromptWithPolicy, { ...base, memberPolicies: policies, unrelatedLegacyExtra: true })).not.toBeNull();
});

for (const operation of [MSG.conversationPrompt, MSG.conversationPromptWithPolicy]) {
  test(`${operation} accepts attachment-only prompts and enforces existing upload limits`, () => {
    const ref = { id: "upload", filePath: "/uploads/file", fileName: "file.txt", mimeType: "text/plain", kind: "file", size: 10 * 1024 * 1024 };
    const input = { conversationId: "c", topicId: "t", requestId: "r", text: "",
      ...(operation === MSG.conversationPromptWithPolicy ? { memberPolicies: [{ botId: "b", filesystem: "read-write" }] } : {}) };
    expect(parseControlPayload(operation, { ...input, media: [ref] })).not.toBeNull();
    expect(parseControlPayload(operation, { ...input, media: Array.from({ length: 5 }, (_, i) => ({ ...ref, id: `upload-${i}` })) })).not.toBeNull();
    expect(parseControlPayload(operation, { ...input, media: [] })).not.toBeNull();
    for (const media of [[{ ...ref, size: ref.size + 1 }], Array.from({ length: 6 }, () => ref), [{ ...ref, size: -1 }], [{ ...ref, filePath: "" }], [null], "file"]) {
      expect(parseControlPayload(operation, { ...input, media })).toBeNull();
    }
  });
}

test("Topic concurrency limits validate on both creation RPCs without changing extra-field handling", () => {
  for (const kind of [MSG.topicsCreate, MSG.groupTopicsCreate]) {
    const base = { conversationId: "c", title: "t", ...(kind === MSG.groupTopicsCreate
      ? { target: { workspace: "backend", isolation: "shared" } } : {}) };
    for (const value of [undefined, 1, 2, 64]) {
      expect(parseControlPayload(kind, { ...base, ...(value !== undefined ? { maxConcurrentMemberTurns: value } : {}) })).not.toBeNull();
    }
    for (const value of [0, -1, 1.5, NaN, Infinity, 65, null, "2", []]) {
      expect(parseControlPayload(kind, { ...base, maxConcurrentMemberTurns: value })).toBeNull();
    }
    expect(parseControlPayload(kind, { ...base, unrelatedLegacyExtra: true })).not.toBeNull();
  }
});

test("group workspace mode is a creation-time choice with no update path", () => {
  const base = { title: "Release Team", botIds: ["bot_a", "bot_b"] };
  for (const workspaceMode of ["shared", "per-member"]) {
    expect(parseControlPayload(MSG.groupsCreate, { ...base, workspaceMode })).not.toBeNull();
  }
  expect(parseControlPayload(MSG.groupsCreate, { ...base, workspaceMode: "per-workspace" })).toBeNull();
  expect(parseControlPayload(MSG.groupsUpdate, { id: "conversation_g", workspaceMode: "per-member" })).toBeNull();
  expect(parseControlPayload(MSG.groupTopicsCreate, { conversationId: "conversation_g", title: "Sprint" })).not.toBeNull();
});

test("the automatic-collaboration switch payload is a single boolean", () => {
  expect(MSG.conversationRouterSet).toBe("control.conversations.router.set");
  expect(parseControlPayload(MSG.conversationRouterGet, {})).not.toBeNull();
  expect(parseControlPayload(MSG.conversationRouterGet, { enabled: true })).toBeNull();
  for (const enabled of [true, false]) {
    expect(parseControlPayload(MSG.conversationRouterSet, { enabled })).toEqual({ enabled });
  }
  for (const bad of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, { enabled: true, command: "x" }, null, "on"]) {
    expect(parseControlPayload(MSG.conversationRouterSet, bad)).toBeNull();
  }
});

test("the router update payload is a per-key patch bounded on the wire only", () => {
  expect(MSG.conversationRouterUpdate).toBe("control.conversations.router.update");
  expect(parseControlPayload(MSG.conversationRouterUpdate, {})).toEqual({});
  for (const ok of [
    { enabled: true },
    { enabled: false },
    { command: "/usr/bin/router" },
    { command: "" },
    { command: null },
    { authEnv: "ROUTER_TOKEN" },
    { authEnv: null },
    { enabled: false, command: null, authEnv: null },
  ]) {
    expect(parseControlPayload(MSG.conversationRouterUpdate, ok)).toEqual(ok);
  }
  const full = { enabled: true, command: "/usr/bin/router", authEnv: "ROUTER_TOKEN" };
  expect(parseControlPayload(MSG.conversationRouterUpdate, full)).toEqual(full);
  // Blank strings, newlines, and non-matching env names are the config layer's call.
  expect(parseControlPayload(MSG.conversationRouterUpdate, { command: "   " })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationRouterUpdate, { command: "/usr/bin/router\n" })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationRouterUpdate, { authEnv: "9token" })).not.toBeNull();
  // Length bounds are the wire's call.
  expect(parseControlPayload(MSG.conversationRouterUpdate, { command: "x".repeat(4096) })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationRouterUpdate, { authEnv: "A".repeat(128) })).not.toBeNull();
  for (const bad of [
    { enabled: "true" },
    { enabled: null },
    { enabled: 1 },
    { command: 5 },
    { command: true },
    { authEnv: [] },
    { authEnv: 5 },
    { enabled: true, extra: 1 },
    { command: "/usr/bin/router", extra: 1 },
    { command: "x".repeat(4097) },
    { authEnv: "A".repeat(129) },
    null,
    "on",
    [],
  ]) {
    expect(parseControlPayload(MSG.conversationRouterUpdate, bad)).toBeNull();
  }
});

test("parseControlPayload accepts a well-formed fsWrite payload", () => {
  const ok = parseControlPayload(MSG.fsWrite, {
    workspace: "home", path: "a.txt", content: "hi",
    expected: { mtimeMs: 1, size: 2 },
  });
  expect(ok).not.toBeNull();
  expect(ok?.workspace).toBe("home");
});

test("parseControlPayload rejects fsWrite missing required fields", () => {
  expect(parseControlPayload(MSG.fsWrite, { workspace: "home", path: "a.txt" })).toBeNull(); // no content/expected
  expect(parseControlPayload(MSG.fsWrite, { workspace: "home", path: "a.txt", content: "x", expected: { mtimeMs: 1 } })).toBeNull(); // expected.size missing
  expect(parseControlPayload(MSG.fsWrite, null)).toBeNull();
  expect(parseControlPayload(MSG.fsWrite, "nope")).toBeNull();
});

test("parseControlPayload rejects fsWrite with wrong field types", () => {
  expect(parseControlPayload(MSG.fsWrite, { workspace: 1, path: "a", content: "x", expected: { mtimeMs: 1, size: 2 } })).toBeNull();
  expect(parseControlPayload(MSG.fsWrite, { workspace: "w", path: "a", content: 5, expected: { mtimeMs: 1, size: 2 } })).toBeNull();
});

test("parseControlPayload validates prompt: required strings, optional media array", () => {
  expect(parseControlPayload(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", text: "hi", senderId: "u" })).not.toBeNull();
  expect(parseControlPayload(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", text: "hi", senderId: "u", media: [] })).not.toBeNull();
  expect(parseControlPayload(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", senderId: "u" })).toBeNull(); // no text
  expect(parseControlPayload(MSG.prompt, { chatKey: "relay:a1", sessionAlias: "s", text: "hi", senderId: "u", media: "x" })).toBeNull(); // media not array
});

test("fsCreate enforces the kind literal union", () => {
  expect(parseControlPayload(MSG.fsCreate, { workspace: "w", path: "p", kind: "file" })).not.toBeNull();
  expect(parseControlPayload(MSG.fsCreate, { workspace: "w", path: "p", kind: "dir" })).not.toBeNull();
  expect(parseControlPayload(MSG.fsCreate, { workspace: "w", path: "p", kind: "socket" })).toBeNull();
});

test("chatKey-only and chatKey+alias families validate their shape", () => {
  expect(parseControlPayload(MSG.sessionsList, { chatKey: "relay:a1" })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsList, {})).toBeNull();
  expect(parseControlPayload(MSG.sessionsList, {
    chatKey: "relay:a1", offset: 0, limit: 5, archivedOnly: true, workspace: "",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsList, { chatKey: "relay:a1", agent: "codex" })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsList, { chatKey: "relay:a1", archivedOnly: "yes" })).toBeNull();
  expect(parseControlPayload(MSG.sessionsList, { chatKey: "relay:a1", workspace: 3 })).toBeNull();
  expect(parseControlPayload(MSG.sessionsRemove, { chatKey: "relay:a1", alias: "s" })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsRemove, { chatKey: "relay:a1" })).toBeNull();
});

test("upload requires filename, content, mimeType strings", () => {
  expect(parseControlPayload(MSG.upload, { filename: "a", content: "b64", mimeType: "text/plain" })).not.toBeNull();
  expect(parseControlPayload(MSG.upload, { filename: "a", content: "b64" })).toBeNull();
});

test("session effort RPC payloads require a session alias and effort value", () => {
  expect(parseControlPayload(MSG.sessionEffortGet, {
    chatKey: "relay:a1", sessionAlias: "backend",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionEffortSet, {
    chatKey: "relay:a1", sessionAlias: "backend", effort: "high",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionEffortSet, {
    chatKey: "relay:a1", sessionAlias: "backend",
  })).toBeNull();
});

test("the session model get payload accepts an optional boolean refresh", () => {
  expect(parseControlPayload(MSG.sessionModelGet, {
    chatKey: "relay:a1", sessionAlias: "backend",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionModelGet, {
    chatKey: "relay:a1", sessionAlias: "backend", refresh: true,
  })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionModelGet, {
    chatKey: "relay:a1", sessionAlias: "backend", refresh: false,
  })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionModelGet, {
    chatKey: "relay:a1", sessionAlias: "backend", refresh: "yes",
  })).toBeNull();
  expect(parseControlPayload(MSG.sessionModelGet, {
    chatKey: "relay:a1", sessionAlias: "backend", refresh: 1,
  })).toBeNull();
  expect(parseControlPayload(MSG.sessionModelGet, {
    chatKey: "relay:a1", sessionAlias: "backend", refresh: true,
  })).toMatchObject({ refresh: true });
});

test("Git RPC payloads accept only structured operations", () => {
  expect(parseControlPayload(MSG.gitStatus, { workspace: "project" })).not.toBeNull();
  expect(parseControlPayload(MSG.gitStage, { workspace: "project", paths: ["a.ts"] })).not.toBeNull();
  expect(parseControlPayload(MSG.gitStage, { workspace: "project", paths: [1] })).toBeNull();
  expect(parseControlPayload(MSG.gitUntrack, { workspace: "project", paths: ["a.ts"] })).not.toBeNull();
  expect(parseControlPayload(MSG.gitUntrack, { workspace: "project" } as never)).toBeNull();
  expect(parseControlPayload(MSG.gitDiscard, { workspace: "project", paths: ["a.ts"] })).not.toBeNull();
  expect(parseControlPayload(MSG.gitDiscard, { workspace: "project", paths: [1] })).toBeNull();
  expect(parseControlPayload(MSG.gitCommit, { workspace: "project", message: "feat: x" })).not.toBeNull();
  expect(parseControlPayload(MSG.gitFetch, { workspace: "project", remote: "origin" })).not.toBeNull();
  expect(parseControlPayload(MSG.gitPull, { workspace: "project" })).not.toBeNull();
  expect(parseControlPayload(MSG.gitPush, { workspace: "project", setUpstream: true, remote: "origin" })).not.toBeNull();
  expect(parseControlPayload(MSG.gitCheckout, { workspace: "project", branch: "feature", create: true, startPoint: "main" })).not.toBeNull();
  expect(parseControlPayload(MSG.gitWorktreeCreate, {
    workspace: "project", workspaceName: "project-feature", branch: "feature", createBranch: true,
  })).not.toBeNull();
  expect(parseControlPayload(MSG.gitWorktreeCreate, {
    workspace: "project", workspaceName: "project-feature", branch: "feature", path: "/tmp/escape",
  } as never)).toBeNull();
});

test("every registered validator returns null for a non-object payload", () => {
  for (const type of Object.keys(CONTROL_PAYLOAD_VALIDATORS) as (keyof typeof CONTROL_PAYLOAD_VALIDATORS)[]) {
    expect(CONTROL_PAYLOAD_VALIDATORS[type](null)).toBeNull();
    expect(CONTROL_PAYLOAD_VALIDATORS[type](42)).toBeNull();
  }
});

test("recoverable terminal RPC payloads require hub-stamped viewerId and reject browser cwd", () => {
  expect(parseControlPayload(MSG.terminalOpen, {
    chatKey: "relay:a1", sessionAlias: "demo", viewerId: "v1", cols: 80, rows: 24,
  })).not.toBeNull();
  expect(parseControlPayload(MSG.terminalOpen, {
    chatKey: "relay:a1", sessionAlias: "demo", cols: 80, rows: 24,
  })).toBeNull();
  expect(parseControlPayload(MSG.terminalOpen, {
    chatKey: "relay:a1", sessionAlias: "demo", viewerId: "v1", cols: 80, rows: 24, cwd: "/tmp",
  } as never)).toBeNull();
  expect(parseControlPayload(MSG.terminalTakeControl, {
    attachmentId: "a1", generation: "g1", viewerId: "v1",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.terminalResync, {
    attachmentId: "a1", generation: "g1", viewerId: "v1",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.terminalTerminate, {
    terminalId: "t1", generation: "g1",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.terminalTerminate, {
    terminalId: "t1",
  })).toBeNull();
});

test("recoverable terminal event payloads validate attachment-scoped hub stamps", () => {
  expect(parseTerminalEventPayload(MSG.terminalStreamStart, {
    attachmentId: "a1", viewerId: "v1",
  })).not.toBeNull();
  expect(parseTerminalEventPayload(MSG.terminalInput, {
    attachmentId: "a1", generation: "g1", viewerId: "v1", dataBase64: Buffer.from("x").toString("base64"),
  })).not.toBeNull();
  expect(parseTerminalEventPayload(MSG.terminalInput, {
    terminalId: "t1", data: "legacy",
  })).toBeNull();
  expect(parseTerminalEventPayload(MSG.terminalResize, {
    attachmentId: "a1", generation: "g1", viewerId: "v1", cols: 80, rows: 24,
  })).not.toBeNull();
  expect(parseTerminalEventPayload(MSG.terminalHeartbeat, {
    attachmentId: "a1", viewerId: "v1",
  })).not.toBeNull();
  expect(parseTerminalEventPayload(MSG.terminalDetach, {
    attachmentId: "a1", viewerId: "v1",
  })).not.toBeNull();
  expect(parseTerminalEventPayload(MSG.terminalViewerEvent, {
    viewerId: "v1",
    attachmentId: "a1",
    event: {
      kind: "terminal-bytes",
      generation: "g1",
      epoch: 1,
      sequence: 1,
      dataBase64: Buffer.from("x").toString("base64"),
    },
  })).not.toBeNull();
  expect(parseTerminalEventPayload(MSG.terminalResourceExit, {
    terminalId: "t1", generation: "g1", reason: "explicit-close", code: 0,
  })).not.toBeNull();
});

test("Bot avatar wire writes accept only strict versioned configs and update null clearing", () => {
  const avatar = { version: 1, kind: "character", shape: "nuage", color: "bleu", expression: "curieux", motion: "auto" };
  const create = { name: "Reviewer", agent: "codex", workspace: "backend" };
  for (const valid of [avatar, { ...avatar, motion: "off" }, { version: 1, kind: "text", value: "🤖" }]) {
    expect(parseControlPayload(MSG.botsCreate, { ...create, avatar: valid })).toEqual({ ...create, avatar: valid });
    expect(parseControlPayload(MSG.botsUpdate, { id: "bot_1", avatar: valid })).toEqual({ id: "bot_1", avatar: valid });
  }
  for (const invalid of [
    "🤖", "", {}, [], 42,
    { ...avatar, version: 2 }, { ...avatar, kind: "default" }, { ...avatar, shape: "circle" },
    { ...avatar, color: "red" }, { ...avatar, expression: "unknown" }, { ...avatar, motion: "loop" },
    { ...avatar, state: "working" }, { ...avatar, activityKey: "run_1" },
    { version: 1, kind: "text", value: " " }, { version: 1, kind: "text", value: "x".repeat(513) },
  ]) {
    expect(parseControlPayload(MSG.botsCreate, { ...create, avatar: invalid })).toBeNull();
    expect(parseControlPayload(MSG.botsUpdate, { id: "bot_1", avatar: invalid })).toBeNull();
  }
  expect(parseControlPayload(MSG.botsCreate, { ...create, avatar: null })).toBeNull();
  expect(parseControlPayload(MSG.botsCreate, create)).toEqual(create);
  expect(parseControlPayload(MSG.botsUpdate, { id: "bot_1", avatar: null })).toEqual({ id: "bot_1", avatar: null });
  expect(parseControlPayload(MSG.botsUpdate, { id: "bot_1" })).toEqual({ id: "bot_1" });
});

test("Bot and Conversation control RPCs validate product IDs, not hidden aliases", () => {
  expect(parseControlPayload(MSG.botsCreate, {
    name: "Reviewer", agent: "codex", workspace: "backend",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.botsCreate, { name: "Reviewer" })).toBeNull();
  expect(parseControlPayload(MSG.botsUpdate, { id: "bot_1", name: "X", avatar: null })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationsList, {})).not.toBeNull();
  expect(parseControlPayload(MSG.conversationsList, { botId: "bot_1" })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, {
    conversationId: "conversation_1", topicId: "topic_1", requestId: "req", text: "hi",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, {
    conversationId: "conversation_1", topicId: "topic_1", requestId: "req", text: "hi",
    target: { botId: "bot_1" },
  })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, {
    conversationId: "conversation_1", topicId: "topic_1", requestId: "req", text: "hi",
    target: { mode: "members", botIds: ["bot_1", "bot_2"] },
  })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, {
    conversationId: "conversation_1", topicId: "topic_1", requestId: "req", text: "hi",
    target: { mode: "everyone" },
  })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, {
    conversationId: "conversation_1", topicId: "topic_1", requestId: "req", text: "hi",
    target: { mode: "members", botIds: [] },
  })).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, {
    conversationId: "conversation_1", topicId: "topic_1", requestId: "req", text: "hi",
    target: { mode: "members", botIds: "bot_1" },
  })).toBeNull();
  expect(parseControlPayload(MSG.conversationHistory, {
    conversationId: "conversation_1", topicId: "topic_1", afterSeq: 0, limit: 50,
  })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationHistory, {
    conversationId: "conversation_1", topicId: "topic_1", limit: 20, direction: "newest-first",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.conversationHistory, {
    conversationId: "conversation_1", topicId: "topic_1", direction: "sideways",
  })).toBeNull();
  expect(parseControlPayload(MSG.conversationHistory, {
    conversationId: "conversation_1", topicId: "topic_1", beforeSeq: 5, limit: 2, direction: "newest-first",
  })).toBeNull();
  expect(parseControlPayload(MSG.runsList, { conversationId: "conversation_1", topicId: "topic_1" })).not.toBeNull();
  expect(parseControlPayload(MSG.runsList, { conversationId: "conversation_1" })).toBeNull();
  expect(parseControlPayload(MSG.runsList, { conversationId: "conversation_1", topicId: "topic_1", limit: 10 })).not.toBeNull();
  expect(parseControlPayload(MSG.runsList, { conversationId: "conversation_1", topicId: "topic_1", limit: "many" })).toBeNull();
  expect(parseControlPayload(MSG.runsCancel, { runId: "run_1" })).not.toBeNull();
  expect(parseControlPayload(MSG.runsCancel, { alias: "brt_x" } as never)).toBeNull();
});
test("parseControlPayload validates group RPC shapes and rejects junk isolation", () => {
  expect(parseControlPayload(MSG.groupsCreate, {
    title: "Release Team", botIds: ["bot_a", "bot_b"], leadBotId: "bot_a",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.groupsCreate, { title: "Solo", botIds: ["only"] })).not.toBeNull();
  expect(parseControlPayload(MSG.groupsCreate, { title: "Solo", botIds: "only" })).toBeNull();
  expect(parseControlPayload(MSG.groupsUpdate, { id: "conversation_g", title: "Renamed" })).not.toBeNull();
  expect(parseControlPayload(MSG.groupsUpdate, { title: "Renamed" })).toBeNull();
  expect(parseControlPayload(MSG.groupsDelete, { id: "conversation_g" })).not.toBeNull();
  expect(parseControlPayload(MSG.groupsGet, { id: "conversation_g" })).not.toBeNull();
  expect(parseControlPayload(MSG.groupsList, {})).not.toBeNull();
  expect(parseControlPayload(MSG.groupsList, undefined)).not.toBeNull();
  expect(parseControlPayload(MSG.groupTopicsCreate, {
    conversationId: "conversation_g", title: "Sprint 1",
    target: { workspace: "backend", isolation: "shared-single-writer" },
  })).not.toBeNull();
  expect(parseControlPayload(MSG.groupTopicsCreate, {
    conversationId: "conversation_g", title: "Bad",
    target: { workspace: "backend", isolation: "mesh" },
  })).toBeNull();
  expect(parseControlPayload(MSG.groupTopicsSetIsolation, {
    conversationId: "conversation_g", topicId: "topic_1", isolation: "worktree-per-member",
  })).not.toBeNull();
  for (const isolation of ["mesh", "", null, 1]) {
    expect(parseControlPayload(MSG.groupTopicsSetIsolation, {
      conversationId: "conversation_g", topicId: "topic_1", isolation,
    })).toBeNull();
  }
  expect(parseControlPayload(MSG.groupTopicsSetIsolation, { topicId: "topic_1", isolation: "shared" })).toBeNull();
  // Structured target resource bounds: gate acquisition is process-lifetime
  // state, so an oversized array or an absurd id must be refused at the wire.
  const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `b${i}`);
  const promptWith = (botIds: string[]) => ({
    conversationId: "c", topicId: "t", requestId: "r", text: "x",
    target: { mode: "members", botIds },
  });
  expect(parseControlPayload(MSG.conversationPrompt, promptWith(ids(64)))).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, promptWith(ids(65)))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, promptWith(["x".repeat(129)]))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, promptWith(["x".repeat(128)]))).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, promptWith([""]))).toBeNull();
  // Duplicate member ids are ambiguous input: an explicit selection naming
  // the same Bot twice must be refused at the wire (the server rejects it
  // with invalid-target; the array-length bound must mean unique members).
  expect(parseControlPayload(MSG.conversationPrompt, promptWith(["bot_a", "bot_a"]))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, promptWith(["bot_a", "bot_b", "bot_a"]))).toBeNull();
  // The variants are a mutually exclusive union: mixed shapes are ambiguous
  // input and must be refused, never interpreted as whichever variant the
  // validator happens to check first (botId+mode would otherwise downgrade
  // an `automatic` PR7 refusal into a direct execution of botId).
  const mixed = (target: Record<string, unknown>) => ({
    conversationId: "c", topicId: "t", requestId: "r", text: "x", target,
  });
  expect(parseControlPayload(MSG.conversationPrompt, mixed({ botId: "bot_a", mode: "members", botIds: ["bot_b"] }))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, mixed({ botId: "bot_a", mode: "automatic" }))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, mixed({ botId: "bot_a", botIds: ["bot_b"] }))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, mixed({ mode: "everyone", botIds: ["bot_b"] }))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, mixed({ mode: "members" }))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, mixed({ botId: "bot_a" }))).not.toBeNull();
  // Legacy single-Bot target: same id-length bound, since the server normalizes
  // it into a members target and the id would reach gate acquisition.
  const singleWith = (botId: string) => ({
    conversationId: "c", topicId: "t", requestId: "r", text: "x",
    target: { botId },
  });
  expect(parseControlPayload(MSG.conversationPrompt, singleWith("x".repeat(128)))).not.toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, singleWith("x".repeat(129)))).toBeNull();
  expect(parseControlPayload(MSG.conversationPrompt, singleWith(""))).toBeNull();
  // Worktree creation is admitted; the core still verifies every resource/cwd.
  expect(parseControlPayload(MSG.groupTopicsCreate, {
    conversationId: "conversation_g", title: "Bad",
    target: { workspace: "backend", isolation: "worktree-per-member" },
  })).not.toBeNull();
  expect(parseControlPayload(MSG.groupTopicsCreate, {
    conversationId: "conversation_g", title: "Good",
    target: { workspace: "backend", isolation: "shared" },
  })).not.toBeNull();
  expect(parseControlPayload(MSG.groupTopicsCreate, {
    conversationId: "conversation_g", title: "Bad", target: { isolation: "shared" },
  })).toBeNull();
  expect(parseControlPayload(MSG.groupTopicsArchive, {
    conversationId: "conversation_g", topicId: "topic_1",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.groupTopicsTeardown, {
    conversationId: "conversation_g", topicId: "topic_1",
  })).not.toBeNull();
  expect(parseControlPayload(MSG.groupTopicsTeardown, { conversationId: "conversation_g" })).toBeNull();
});

test("bot removal payloads keep the request id and preview revision", () => {
  expect(parseControlPayload(MSG.botsRemovePreview, { id: "bot_a" })?.id).toBe("bot_a");
  expect(parseControlPayload(MSG.botsRemovePreview, {})).toBeNull();
  const removal = parseControlPayload(MSG.botsRemove, {
    id: "bot_a",
    requestId: "req-1",
    previewRevision: "abc123",
    clearDirectHistory: true,
    releaseDirectBindings: false,
  });
  expect(removal).toEqual({
    id: "bot_a",
    requestId: "req-1",
    previewRevision: "abc123",
    clearDirectHistory: true,
    releaseDirectBindings: false,
  });
  expect(parseControlPayload(MSG.botsRemove, { id: "bot_a", requestId: "req-1" })).toBeNull();
  expect(parseControlPayload(MSG.lifecycleOperationsGet, { id: "bot-remove:req-1" })?.id).toBe("bot-remove:req-1");
  expect(parseControlPayload(MSG.lifecycleOperationsGet, { id: "" })).toBeNull();
});

test("bot removal accepts the dedicated-workspace cleanup flag and rejects a non-boolean one", () => {
  const base = { id: "bot_a", requestId: "req-1", previewRevision: "abc123" };
  expect(parseControlPayload(MSG.botsRemove, { ...base, deleteDedicatedWorkspace: true }))
    .toEqual({ ...base, deleteDedicatedWorkspace: true });
  expect(parseControlPayload(MSG.botsRemove, { ...base, deleteDedicatedWorkspace: false }))
    .toEqual({ ...base, deleteDedicatedWorkspace: false });
  // An omitted flag means "do not touch the workspace".
  expect(parseControlPayload(MSG.botsRemove, base)).toEqual(base);
  for (const bad of ["true", 1, null, {}, []]) {
    expect(parseControlPayload(MSG.botsRemove, { ...base, deleteDedicatedWorkspace: bad })).toBeNull();
  }
});

test("the Jev get payload is an empty read", () => {
  expect(MSG.jevGet).toBe("control.jev.get");
  expect(parseControlPayload(MSG.jevGet, {})).toEqual({});
  for (const bad of [{ apiKey: "sk-x" }, null, "get"]) {
    expect(parseControlPayload(MSG.jevGet, bad)).toBeNull();
  }
});

test("the Jev update payload is a per-key patch with null clearing the key", () => {
  expect(MSG.jevUpdate).toBe("control.jev.update");
  expect(parseControlPayload(MSG.jevUpdate, {})).toEqual({});
  for (const ok of [
    { endpoint: "https://api.typesafe.ai/v1/systemone" },
    { endpoint: "" },
    { proxyUrl: "http://127.0.0.1:8080" },
    { proxyUrl: null },
    { apiKey: "sk-1234567890abcd" },
    { apiKey: null },
    { endpoint: "https://x/v1", proxyUrl: null, apiKey: "sk-1" },
  ]) {
    expect(parseControlPayload(MSG.jevUpdate, ok)).toEqual(ok);
  }
  // Scheme and emptiness are the daemon's call; the wire bounds length only.
  expect(parseControlPayload(MSG.jevUpdate, { endpoint: "   " })).not.toBeNull();
  expect(parseControlPayload(MSG.jevUpdate, { endpoint: "x".repeat(2048) })).not.toBeNull();
  expect(parseControlPayload(MSG.jevUpdate, { endpoint: "x".repeat(2049) })).toBeNull();
  expect(parseControlPayload(MSG.jevUpdate, { proxyUrl: "x".repeat(2048) })).not.toBeNull();
  expect(parseControlPayload(MSG.jevUpdate, { proxyUrl: "x".repeat(2049) })).toBeNull();
  expect(parseControlPayload(MSG.jevUpdate, { apiKey: "k".repeat(512) })).not.toBeNull();
  expect(parseControlPayload(MSG.jevUpdate, { apiKey: "k".repeat(513) })).toBeNull();
  for (const bad of [
    { endpoint: 5 },
    { proxyUrl: 5 },
    { apiKey: 5 },
    { apiKey: true },
    { enabled: true },
    { endpoint: "https://x", extra: 1 },
  ]) {
    expect(parseControlPayload(MSG.jevUpdate, bad)).toBeNull();
  }
});

test("the Jev test payload carries an optional unsaved key", () => {
  expect(MSG.jevTest).toBe("control.jev.test");
  expect(parseControlPayload(MSG.jevTest, {})).toEqual({});
  expect(parseControlPayload(MSG.jevTest, { apiKey: "sk-unsaved" })).toEqual({ apiKey: "sk-unsaved" });
  expect(parseControlPayload(MSG.jevTest, { apiKey: "k".repeat(512) })).not.toBeNull();
  expect(parseControlPayload(MSG.jevTest, { apiKey: "k".repeat(513) })).toBeNull();
  for (const bad of [{ apiKey: 5 }, { apiKey: null }, { endpoint: "https://x" }]) {
    expect(parseControlPayload(MSG.jevTest, bad)).toBeNull();
  }
  // Every new RPC is registered: the registry is closed over ControlRpcType.
  expect(CONTROL_PAYLOAD_VALIDATORS[MSG.jevGet]).toBeDefined();
  expect(CONTROL_PAYLOAD_VALIDATORS[MSG.jevUpdate]).toBeDefined();
  expect(CONTROL_PAYLOAD_VALIDATORS[MSG.jevTest]).toBeDefined();
});

test("the Jev settings and test result parsers accept only their exact shapes", () => {
  const settings = {
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    keyConfigured: false,
    keyMasked: null,
  };
  expect(parseJevSettings(settings)).toEqual(settings);
  expect(parseJevSettings({ ...settings, proxyUrl: "http://127.0.0.1:8080", keyConfigured: true, keyMasked: "sk-…abcd" }))
    .toMatchObject({ proxyUrl: "http://127.0.0.1:8080", keyConfigured: true, keyMasked: "sk-…abcd" });
  for (const bad of [
    null,
    {},
    { ...settings, endpoint: "" },
    { ...settings, model: 5 },
    { ...settings, keyConfigured: "yes" },
    { ...settings, keyMasked: 5 },
    { ...settings, proxyUrl: 5 },
    { ...settings, extra: 1 },
  ]) {
    expect(() => parseJevSettings(bad)).toThrow();
  }
  expect(parseJevTestResult({ ok: true, latencyMs: 812 })).toEqual({ ok: true, latencyMs: 812 });
  for (const code of ["region-blocked", "bad-key", "network", "http-error", "malformed-response", "no-key"]) {
    expect(parseJevTestResult({ ok: false, code, message: "blocked" })).toEqual({ ok: false, code, message: "blocked" });
  }
  for (const bad of [
    null,
    {},
    { ok: true },
    { ok: true, latencyMs: -1 },
    { ok: true, latencyMs: 1, extra: 2 },
    { ok: false, code: "mystery", message: "x" },
    { ok: false, code: "bad-key" },
    { ok: false, code: "bad-key", message: "  " },
    { ok: false, code: "bad-key", message: "x".repeat(501) },
    { ok: "yes" },
  ]) {
    expect(() => parseJevTestResult(bad)).toThrow();
  }
});

test("jev-not-configured is a legal router failure code", () => {
  expect(parseRouterAvailability({
    status: "failed",
    configPath: "conversations.router",
    reason: { code: "jev-not-configured", message: "Automatic collaboration needs a Jev API key." },
  })).toMatchObject({ status: "failed", reason: { code: "jev-not-configured" } });
});

test("scoped runs history requests are bounded, unique, and reject unknown keys", () => {
  expect(MSG.runsDetailsBatch).toBe("control.runs.details.batch");
  expect(MSG.runsTraceGet).toBe("control.runs.trace.get");
  const batch = { conversationId: "c", topicId: "t", runIds: ["r1", "r2"] };
  expect(parseControlPayload(MSG.runsDetailsBatch, batch)).toEqual(batch);
  for (const bad of [{}, { ...batch, runIds: [] },
    { ...batch, runIds: Array.from({ length: 51 }, (_, i) => `r${i}`) },
    { ...batch, runIds: ["r1", "r1"] }, { ...batch, runIds: [""] },
    { ...batch, runIds: ["r1"], conversationId: "" }, { ...batch, extra: 1 }]) {
    expect(parseControlPayload(MSG.runsDetailsBatch, bad)).toBeNull();
  }
  const trace = { conversationId: "c", topicId: "t", runId: "r", memberTurnId: "m", attempt: 2 };
  expect(parseControlPayload(MSG.runsTraceGet, trace)).toEqual(trace);
  expect(parseControlPayload(MSG.runsTraceGet, { ...trace, afterSeq: 0, limit: 200 })).not.toBeNull();
  for (const bad of [{}, { ...trace, attempt: 0 }, { ...trace, attempt: 1.5 },
    { ...trace, attempt: NaN }, { ...trace, attempt: Infinity },
    { ...trace, limit: 0 }, { ...trace, limit: 201 }, { ...trace, afterSeq: -1 },
    { ...trace, memberTurnId: "" }, { ...trace, unknown: true }]) {
    expect(parseControlPayload(MSG.runsTraceGet, bad)).toBeNull();
  }
});

test("scoped member cancellation requires only bounded Run and MemberTurn IDs", () => {
  const payload = { runId: "run_1", memberTurnId: "mturn_1" };
  expect(parseControlPayload(MSG.runsCancelMember, payload)).toEqual(payload);
  expect(parseControlPayload(MSG.runsCancelMember, { runId: "r".repeat(128), memberTurnId: "m".repeat(128) })).not.toBeNull();
  for (const bad of [
    null, [], "nope", {}, { runId: "run_1" }, { memberTurnId: "mturn_1" },
    { ...payload, runId: "" }, { ...payload, memberTurnId: "" },
    { ...payload, runId: 1 }, { ...payload, memberTurnId: null },
    { ...payload, runId: "r".repeat(129) }, { ...payload, memberTurnId: "m".repeat(129) },
    { ...payload, unknown: true }, { ...payload, conversationId: "conversation_1" },
  ]) {
    expect(parseControlPayload(MSG.runsCancelMember, bad)).toBeNull();
  }
});

test("additive correlation attempt identity accepts legacy shapes and rejects empty ids", () => {
  const legacy = { conversationId: "c", topicId: "t" };
  const permission = { title: "allow", availableOutcomes: ["allow_once"] };
  expect(parseControlPayload(MSG.interactionRequest, { ...legacy, requestId: "r", kind: "permission", expiresAt: 1, permission })).not.toBeNull();
  expect(parseControlPayload(MSG.interactionRequest,
    { ...legacy, requestId: "r", kind: "permission", expiresAt: 1, permission, conversation: { ...legacy, attempt: 3, sourceTurnId: "s" } })).not.toBeNull();
  expect(parseControlPayload(MSG.interactionRequest,
    { ...legacy, requestId: "r", kind: "permission", expiresAt: 1, permission, conversation: { ...legacy, attempt: 0 } })).toBeNull();
  expect(parseControlPayload(MSG.interactionRequest,
    { ...legacy, requestId: "r", kind: "permission", expiresAt: 1, permission, conversation: { ...legacy, sourceTurnId: "" } })).toBeNull();
});

test("Bot creation accepts an omitted workspace for automatic default and keeps shape-only blank handling", () => {
  expect(parseControlPayload(MSG.botsCreate, { name: "Reviewer", agent: "codex" })).toEqual({
    name: "Reviewer", agent: "codex",
  });
  for (const workspace of [null, 5, {}, true]) {
    expect(parseControlPayload(MSG.botsCreate, { name: "Reviewer", agent: "codex", workspace })).toBeNull();
  }
  // Shape-only per repo convention; the server rejects blank with the existing
  // workspace_not_registered failure instead of silent automatic creation.
  expect(parseControlPayload(MSG.botsCreate, { name: "Reviewer", agent: "codex", workspace: "" })).not.toBeNull();
});

test("the file write switch RPCs accept only their exact shapes", () => {
  expect(MSG.filesSettingsGet).toBe("control.files.settings.get");
  expect(MSG.filesSettingsUpdate).toBe("control.files.settings.update");

  expect(parseControlPayload(MSG.filesSettingsGet, {})).toEqual({});
  // The read takes no payload: any object carrying fields is rejected rather
  // than silently interpreted. An empty array is the same "no fields" answer
  // `[]` gives the terminal settings getter (arrays have no own keys), so the
  // two switches stay on one convention.
  for (const bad of [null, 42, { enabled: true }, { x: 1 }]) {
    expect(parseControlPayload(MSG.filesSettingsGet, bad)).toBeNull();
  }
  expect(parseControlPayload(MSG.filesSettingsGet, [])).toEqual({});

  expect(parseControlPayload(MSG.filesSettingsUpdate, { enabled: true })).toEqual({ enabled: true });
  expect(parseControlPayload(MSG.filesSettingsUpdate, { enabled: false })).toEqual({ enabled: false });
  for (const bad of [
    null, 42, [], {}, { enabled: "true" }, { enabled: 1 }, { enabled: null },
    { enabled: true, extra: 1 },
  ]) {
    expect(parseControlPayload(MSG.filesSettingsUpdate, bad)).toBeNull();
  }
});
