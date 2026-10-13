import { fileURLToPath } from "node:url";

import {
  MAX_ROUTER_ASSIGNMENTS_PER_DECISION,
  MAX_ROUTER_ASSIGNMENT_ID_LENGTH,
  MAX_ROUTER_TASK_LENGTH,
  type RouterCapabilityRestriction,
  type RoutingDecision,
  type RoutingMember,
} from "./conversation-router-types";

/**
 * The built-in default Conversation Router.
 *
 * Relay Web's automatic-collaboration switch must work on a fresh install with
 * no operator-supplied `conversations.router.command`, so the daemon writes
 * this bundled entry into the config when it turns the switch on. It is a real
 * decision process, not a stub: the same `--capabilities` / `--decide`
 * external-process contract an operator's router must satisfy, probed and
 * bounded by `production-router.ts` exactly like an operator-supplied one.
 *
 * The semantics are deliberately the least surprising ones available without a
 * model, a filesystem, or tools: fan the Run's request out to every enabled
 * member once, in parallel, then complete. It never synthesizes. A cleverer
 * policy would be invented behavior presented as intelligence, and a second
 * in-process routing path would bypass the capability proof the docs promise.
 *
 * Pure at import: nothing here touches the filesystem, the environment, or the
 * process until the caller invokes it.
 */

/** Everything the default router is allowed to reason with, projected from the
 *  engine's `RoutingInput`. Deliberately narrower than `RoutingInput`: the
 *  transcript, the Run state, and the execution target are not evidence for a
 *  fixed fan-out, so they never reach this shape. */
export interface DefaultRouterDecisionInput {
  request: string;
  requestMessageId: string;
  members: readonly RoutingMember[];
  completedAssignmentCount: number;
  remainingBudget: number;
}

/**
 * Deterministic dispatch decision.
 *
 * The order of the guards is the contract: an empty request asks a human,
 * nobody enabled completes, an exhausted budget completes, and a Run that
 * already spent a round completes instead of fanning out forever. Only then
 * does work get dispatched.
 */
export function decideDefaultRouterAssignment(input: DefaultRouterDecisionInput): RoutingDecision {
  const request = input.request.trim();
  if (request.length === 0) {
    return { type: "need-human", question: "The run request is empty." };
  }
  // Disabled members stay routable in metadata but are never executable: the
  // gate rejects them, so the router must choose somebody else rather than
  // have the server repair a disabled selection.
  const enabled = input.members.filter((member) => member.enabled);
  if (enabled.length === 0) {
    return { type: "complete", reason: "No enabled group members are available to assign." };
  }
  if (input.remainingBudget <= 0) {
    return { type: "complete", reason: "The member turn budget is exhausted." };
  }
  // One round per run. A second decision with evidence already on the Run
  // means the fan-out finished; looping it would burn the same budget again.
  if (input.completedAssignmentCount > 0) {
    return { type: "complete", reason: "The default router assigns one round per run." };
  }
  // Both clamps mirror the decision gate: the per-decision assignment cap and
  // the Run's remaining member turns. The router never asks for more than the
  // engine may grant, so a valid decision is never refused downstream.
  const take = Math.min(enabled.length, input.remainingBudget, MAX_ROUTER_ASSIGNMENTS_PER_DECISION);
  const assignments = enabled.slice(0, take).map((member, index) => {
    const qualifiedId = `auto-${index}-${member.botId}`;
    return {
      // The bot id keeps the assignment traceable to a member; the bare index
      // is the fallback for a Group whose ids alone would overflow the cap.
      id: qualifiedId.length <= MAX_ROUTER_ASSIGNMENT_ID_LENGTH ? qualifiedId : `auto-${index}`,
      botId: member.botId,
      task: request.slice(0, MAX_ROUTER_TASK_LENGTH),
      // The trigger is the Run's own request message when it has one; an empty
      // list is valid and simply anchors nothing.
      triggerMessageIds: input.requestMessageId.length > 0 ? [input.requestMessageId] : [],
    };
  });
  return { type: "dispatch", mode: take === 1 ? "single" : "parallel", assignments };
}

/**
 * The capability report the bundled entry prints for `--capabilities`.
 *
 * A function rather than a shared constant: the report is the process's own
 * declaration, and handing out a fresh object keeps a caller from mutating the
 * one value every later probe would serialize.
 */
export function defaultRouterCapabilities(): RouterCapabilityRestriction {
  return {
    toolsDisabled: true,
    filesystemDisabled: true,
    terminalDisabled: true,
    permissionInteractionDisabled: true,
    messagingDisabled: true,
    orchestrationDisabled: true,
    structuredOutputOnly: true,
  };
}

/** The process boundary the entry runs behind. The daemon spawns this same
 *  shape for an operator's router, so the default is not special-cased. */
export interface DefaultRouterCliIo {
  argv: readonly string[];
  readStdin(): Promise<string>;
  writeStdout(text: string): Promise<void>;
  writeStderr(text: string): Promise<void>;
}

const CAPABILITIES_FLAG = "--capabilities";
const DECIDE_FLAG = "--decide";
const USAGE = "usage: default-router-main (--capabilities | --decide) < routing-input.json";

/**
 * `--capabilities` prints the seven restriction flags and exits 0. `--decide`
 * reads a `RoutingInput` from stdin and prints one decision.
 *
 * Every failure path fails closed: a decision is never emitted for input the
 * router could not read, and an unusable invocation exits non-zero with the
 * reason on stderr, so the daemon's probe and decision handling see a hard
 * failure rather than a plausible-looking answer.
 */
export async function runDefaultRouterCli(io: DefaultRouterCliIo): Promise<number> {
  const flag = io.argv[0];
  if (io.argv.length !== 1 || (flag !== CAPABILITIES_FLAG && flag !== DECIDE_FLAG)) {
    await io.writeStderr(`${USAGE}\n`);
    return 2;
  }
  if (flag === CAPABILITIES_FLAG) {
    await io.writeStdout(`${JSON.stringify(defaultRouterCapabilities())}\n`);
    return 0;
  }
  let decision: RoutingDecision;
  try {
    decision = decideDefaultRouterAssignment(readDecisionInput(JSON.parse(await io.readStdin())));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await io.writeStderr(`[xacpx-default-router] ${message}\n`);
    return 1;
  }
  await io.writeStdout(`${JSON.stringify(decision)}\n`);
  return 0;
}

/** stdin is untrusted bytes even when the daemon is the writer, so the shape
 *  is read field by field here: an unreadable field throws and the CLI stays
 *  silent instead of emitting a decision from a half-parsed snapshot. */
function readDecisionInput(value: unknown): DefaultRouterDecisionInput {
  if (typeof value !== "object" || value === null) {
    throw new Error("routing input must be a JSON object");
  }
  const {
    request,
    requestMessageId,
    memberMetadata,
    completedAssignments,
    remainingBudget,
  } = value as Record<"request" | "requestMessageId" | "memberMetadata" | "completedAssignments" | "remainingBudget", unknown>;
  if (typeof request !== "string") {
    throw new Error("routing input requires a string request");
  }
  if (typeof requestMessageId !== "string") {
    throw new Error("routing input requires a string requestMessageId");
  }
  if (typeof remainingBudget !== "number" || !Number.isFinite(remainingBudget)) {
    throw new Error("routing input requires a numeric remainingBudget");
  }
  if (!Array.isArray(completedAssignments)) {
    throw new Error("routing input completedAssignments must be an array");
  }
  if (!Array.isArray(memberMetadata)) {
    throw new Error("routing input memberMetadata must be an array");
  }
  const members: unknown[] = memberMetadata;
  return {
    request,
    requestMessageId,
    members: members.map((entry) => readMember(entry)),
    completedAssignmentCount: completedAssignments.length,
    remainingBudget,
  };
}

/** Only `botId` and `enabled` are decision evidence; the rest of the member
 *  record is presentation the fan-out never reads. */
function readMember(value: unknown): RoutingMember {
  if (typeof value !== "object" || value === null) {
    throw new Error("routing input memberMetadata must contain objects");
  }
  const member = value as Partial<RoutingMember>;
  if (typeof member.botId !== "string" || member.botId.trim().length === 0) {
    throw new Error("routing input memberMetadata entry requires a non-empty botId");
  }
  if (typeof member.enabled !== "boolean") {
    throw new Error("routing input memberMetadata entry requires a boolean enabled flag");
  }
  return value as RoutingMember;
}

const DIST_MARKER = "/dist/";

/**
 * Path to the bundled default-router entry script.
 *
 * The anchoring rule is copied from `resolveHermesAcpShimEntry`: unbundled dev
 * runs (module URL still ends in `.ts`) resolve the sibling `.ts` source the
 * dev runtime executes directly — checked FIRST so a checkout path that happens
 * to contain `/dist/` cannot misresolve. Bundled builds anchor on the last
 * `/dist/` segment, because the daemon and the entry both live under it.
 */
export function resolveDefaultRouterEntry(moduleUrl: string = import.meta.url): string {
  if (moduleUrl.endsWith(".ts")) {
    return fileURLToPath(new URL("./default-router-main.ts", moduleUrl));
  }
  const idx = moduleUrl.lastIndexOf(DIST_MARKER);
  if (idx !== -1) {
    return fileURLToPath(
      new URL(`${moduleUrl.slice(0, idx + DIST_MARKER.length)}conversations/default-router-main.js`),
    );
  }
  return fileURLToPath(new URL("./default-router-main.js", moduleUrl));
}
