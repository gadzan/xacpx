import { expect, test } from "bun:test";
import {
  OFFERED_PERMISSION_KINDS,
  readOfferedPermissionOptions,
  toUpstreamPermissionDecision,
  type OfferedPermissionOption,
} from "../../../../../src/bridge/engine/runtime/runtime-permission-decision";

function offered(...entries: Array<[string, OfferedPermissionOption["kind"]]>): OfferedPermissionOption[] {
  return entries.map(([optionId, kind]) => ({ optionId, kind }));
}

function raw(options: unknown): unknown {
  return { sessionId: "s", options, toolCall: { toolCallId: "t1", title: "edit file" } };
}

test("each outcome selects the offered option of the same kind", () => {
  const options = offered(
    ["allow-1", "allow_once"],
    ["allow-always", "allow_always"],
    ["reject-1", "reject_once"],
    ["reject-always", "reject_always"],
  );
  expect(toUpstreamPermissionDecision("allow_once", options)).toEqual({ outcome: "selected", optionId: "allow-1" });
  expect(toUpstreamPermissionDecision("allow_always", options)).toEqual({ outcome: "selected", optionId: "allow-always" });
  expect(toUpstreamPermissionDecision("reject_once", options)).toEqual({ outcome: "selected", optionId: "reject-1" });
  expect(toUpstreamPermissionDecision("reject_always", options)).toEqual({ outcome: "selected", optionId: "reject-always" });
});

test("a missing exact kind falls back to its sibling, matching upstream's order", () => {
  expect(toUpstreamPermissionDecision("allow_once", offered(["always", "allow_always"]))).toEqual({ outcome: "selected", optionId: "always" });
  expect(toUpstreamPermissionDecision("allow_always", offered(["once", "allow_once"]))).toEqual({ outcome: "selected", optionId: "once" });
  expect(toUpstreamPermissionDecision("reject_always", offered(["no", "reject_once"]))).toEqual({ outcome: "selected", optionId: "no" });
});

test("an outcome with no offered option cancels, as upstream's decisionToResponse does", () => {
  expect(toUpstreamPermissionDecision("allow_once", offered(["no", "reject_once"]))).toEqual({ outcome: "cancel" });
  expect(toUpstreamPermissionDecision("reject_once", offered(["yes", "allow_once"]))).toEqual({ outcome: "cancel" });
  expect(toUpstreamPermissionDecision("allow_always", [])).toEqual({ outcome: "cancel" });
});

test("cancel passes through without touching the offered options", () => {
  expect(toUpstreamPermissionDecision("cancel", offered(["yes", "allow_once"]))).toEqual({ outcome: "cancel" });
});

test("the first offered option of a kind wins when an agent offers duplicates", () => {
  const options = offered(["first", "allow_once"], ["second", "allow_once"]);
  expect(toUpstreamPermissionDecision("allow_once", options)).toEqual({ outcome: "selected", optionId: "first" });
});

test("readOfferedPermissionOptions keeps selectable options and drops the rest", () => {
  const parsed = readOfferedPermissionOptions(
    raw([
      { optionId: "a", kind: "allow_once", name: "Allow once" },
      { optionId: "", kind: "allow_once" },
      { kind: "allow_once" },
      { optionId: "b", kind: "allow_for_session" },
      { optionId: "c", kind: 7 },
      "nonsense",
      null,
      { optionId: "d", kind: "reject_always" },
    ]),
  );
  expect(parsed).toEqual([
    { optionId: "a", kind: "allow_once" },
    { optionId: "d", kind: "reject_always" },
  ]);
  expect(readOfferedPermissionOptions(raw(undefined))).toEqual([]);
  expect(readOfferedPermissionOptions(raw({}))).toEqual([]);
  expect(readOfferedPermissionOptions(null)).toEqual([]);
});

test("OFFERED_PERMISSION_KINDS lists the four SDK v1 kinds with no cancel", () => {
  expect([...OFFERED_PERMISSION_KINDS]).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
});
