// tests/unit/packages/relay-protocol/payload-validators.test.ts
import { expect, test } from "bun:test";
import {
  MSG,
  parseControlPayload,
  parseTerminalEventPayload,
  CONTROL_PAYLOAD_VALIDATORS,
} from "../../../../packages/relay-protocol/src/index";

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
  // Create-time only: worktree-per-member has no provisioning, so a Topic
  // created with it could never execute. Topic responses stay legacy-tolerant.
  expect(parseControlPayload(MSG.groupTopicsCreate, {
    conversationId: "conversation_g", title: "Bad",
    target: { workspace: "backend", isolation: "worktree-per-member" },
  })).toBeNull();
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
