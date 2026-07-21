// tests/unit/packages/relay-protocol/payload-validators.test.ts
import { expect, test } from "bun:test";
import { MSG, parseControlPayload, CONTROL_PAYLOAD_VALIDATORS } from "../../../../packages/relay-protocol/src/index";

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

// The type-level `PayloadFor<T>` bindings are asserted in payload-validators.ts itself,
// where tsc actually sees them — `tests/` is outside every tsconfig's `include`.
