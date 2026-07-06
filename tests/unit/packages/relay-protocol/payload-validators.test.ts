// tests/unit/packages/relay-protocol/payload-validators.test.ts
import { expect, test } from "bun:test";
import {
  MSG,
  parseControlPayload,
  CONTROL_PAYLOAD_VALIDATORS,
  type PayloadFor,
  type FsWritePayload,
  type PromptPayload,
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
  expect(parseControlPayload(MSG.sessionsRemove, { chatKey: "relay:a1", alias: "s" })).not.toBeNull();
  expect(parseControlPayload(MSG.sessionsRemove, { chatKey: "relay:a1" })).toBeNull();
});

test("upload requires filename, content, mimeType strings", () => {
  expect(parseControlPayload(MSG.upload, { filename: "a", content: "b64", mimeType: "text/plain" })).not.toBeNull();
  expect(parseControlPayload(MSG.upload, { filename: "a", content: "b64" })).toBeNull();
});

test("every registered validator returns null for a non-object payload", () => {
  for (const type of Object.keys(CONTROL_PAYLOAD_VALIDATORS) as (keyof typeof CONTROL_PAYLOAD_VALIDATORS)[]) {
    expect(CONTROL_PAYLOAD_VALIDATORS[type](null)).toBeNull();
    expect(CONTROL_PAYLOAD_VALIDATORS[type](42)).toBeNull();
  }
});

// --- Type-level binding (checked by `npx tsc --noEmit`, not at runtime) ---
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// PayloadFor<MSG.fsWrite> is exactly FsWritePayload (not `unknown`, not a widened shape).
type _fsWriteBound = Expect<Equal<PayloadFor<typeof MSG.fsWrite>, FsWritePayload>>;
type _promptBound = Expect<Equal<PayloadFor<typeof MSG.prompt>, PromptPayload>>;

test("type-level bindings compile", () => {
  // The `_fsWriteBound`/`_promptBound` aliases above fail `tsc` if PayloadFor drifts
  // from the hand-written payload type. This runtime assertion just anchors the test.
  const _use: [_fsWriteBound, _promptBound] = [true, true];
  expect(_use).toEqual([true, true]);
});
