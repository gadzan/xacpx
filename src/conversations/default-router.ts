import { fileURLToPath } from "node:url";
import { decideCollaboration, readCollaborationHistory } from "./collaboration-policy";
import { MAX_BOT_ID_LENGTH } from "@ganglion/xacpx-relay-protocol";

import {
  MAX_DURABLE_UNRESOLVED_ISSUES,
  MAX_ROUTER_ASSIGNMENTS_PER_DECISION,
  MAX_ROUTER_ASSIGNMENT_ID_LENGTH,
  MAX_ROUTER_AVAILABILITY_MEMBERS,
  MAX_ROUTER_MEMBER_METADATA,
  MAX_ROUTER_TASK_LENGTH,
  type DurableCollaborationFacts,
  type DurableProgressReduction,
  type MemberAvailability,
  type RouterCapabilityRestriction,
  type RoutingDecision,
  type RoutingMember,
  type RoutingAssignmentRecord,
} from "./conversation-router-types";
import {
  DEFAULT_JEV_ENDPOINT,
  DEFAULT_JEV_MODEL,
  askJevChoice,
  redactJevSecrets,
  type JevAskResult,
  type JevChoice,
} from "./jev-client";

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
 * Jev chooses a next action and member from durable result evidence on each
 * pass. The no-key legacy path fans out once. Both use the same restricted
 * external-process contract and the existing durable Conversation executor.
 *
 * Pure at import: nothing here touches the filesystem, the environment, or the
 * process until the caller invokes it.
 */

/** Public bounded engine evidence used by the bundled routing policies. */
export interface DefaultRouterDecisionInput {
  request: string;
  requestTruncated?: true;
  requestMessageId: string;
  members: readonly RoutingMember[];
  /** Truthful cumulative settled-assignment count, never the window length. */
  completedAssignmentTotal: number;
  /** Settled assignments outside the bounded window (durable, not resolved). */
  omittedAssignmentCount?: number;
  /** Durable Run-scoped sequence for minting assignment ids. */
  assignmentSequence: number;
  /** Durable accounting from the full history; the window above cannot
   *  reconstruct it once its rows are omitted. */
  durableCollaboration?: DurableCollaborationFacts;
  /** Durable progress reduction (design §9): the Run's still-unfinished
   *  work, the current artifact version and its producers, derived from the
   *  full history before the evidence window was applied. */
  durableProgress?: DurableProgressReduction;
  /** Recency window of durable results, retained for the adaptive Jev policy. */
  completedAssignments?: readonly RoutingAssignmentRecord[];
  remainingBudget: number;
  /** The Group's configured lead Bot, when one is set. */
  leadBotId?: string;
  /** Bounded public Topic transcript (newest-first), when the engine provided
   *  one. Only the Jev policy reads it; the fan-out never does. */
  publicTranscript?: readonly {
    id: string;
    seq: number;
    role: "human" | "bot" | "system";
    senderBotId?: string;
    content: string;
    runId?: string;
    contextTruncated?: true;
  }[];
  /** Bounded runtime availability sample (design §8.3). Advice only: a busy
   *  member is still dispatchable, and this never relaxes a gate. */
  availability?: readonly MemberAvailability[];
  /** Members the availability caps left out. */
  omittedAvailabilityCount?: number;
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
  // Production gates credentials before constructing a router. Also protect
  // direct CLI use: never downgrade live Jev work into legacy completion.
  if (input.completedAssignments?.some((row) => row.id.startsWith("jev-"))) {
    return { type: "need-human", question: "Jev credentials are unavailable for this existing collaboration. Restore Jev before continuing; completed work is preserved." };
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
  if (input.completedAssignmentTotal > 0) {
    return { type: "complete", reason: "The default router assigns one round per run." };
  }
  // Both clamps mirror the decision gate: the per-decision assignment cap and
  // the Run's remaining member turns. The router never asks for more than the
  // engine may grant, so a valid decision is never refused downstream.
  const take = Math.min(enabled.length, input.remainingBudget, MAX_ROUTER_ASSIGNMENTS_PER_DECISION);
  const assignments = enabled.slice(0, take).map((member, index) => {
    // The durable sequence replaces the window length, so two different
    // windows can never mint the same id for the same member position.
    const qualifiedId = `auto-${input.assignmentSequence + index}-${member.botId}`;
    return {
      // The bot id keeps the assignment traceable to a member; the bare
      // sequence is the fallback when the member id alone overflows the cap.
      id: qualifiedId.length <= MAX_ROUTER_ASSIGNMENT_ID_LENGTH ? qualifiedId : `auto-${input.assignmentSequence + index}`,
      botId: member.botId,
      task: request.slice(0, MAX_ROUTER_TASK_LENGTH),
      // The trigger is the Run's own request message when it has one; an empty
      // list is valid and simply anchors nothing.
      triggerMessageIds: input.requestMessageId.length > 0 ? [input.requestMessageId] : [],
    };
  });
  return { type: "dispatch", mode: take === 1 ? "single" : "parallel", assignments };
}

export { COLLABORATION_MIN_CONFIDENCE as JEV_MIN_CONFIDENCE } from "./collaboration-policy";

/** The Jev connection settings the daemon passes to the bundled router via
 *  environment variables (never argv: argv is visible to every local process). */
export interface JevRouterEnv {
  endpoint: string;
  apiKey: string;
  proxyUrl?: string;
  model: string;
}

/** The decision input for the Jev policy: the same snapshot the fan-out reads,
 *  plus the Group lead and the connection settings. */
export interface JevRouterDecisionInput extends DefaultRouterDecisionInput {
  jev: JevRouterEnv;
}

/** Injectable ask seam: the CLI wires the real client, tests wire a fake. */
export type JevAskFn = (input: {
  endpoint: string;
  apiKey: string;
  proxyUrl?: string;
  model: string;
  message: string;
  question: string;
  choices: readonly JevChoice[];
}) => Promise<JevAskResult>;

const realJevAsk: JevAskFn = (input) =>
  askJevChoice({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
    model: input.model,
    message: input.message,
    question: input.question,
    choices: input.choices,
  });

/** Adaptive collaboration uses the same restricted Router/finite-choice seam. */
export async function decideJevRouterAssignment(
  input: JevRouterDecisionInput,
  ask: JevAskFn = realJevAsk,
): Promise<RoutingDecision> {
  return decideCollaboration(input, ask);
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
  /** Injected for tests; the real entry passes `process.env`. The daemon's
   *  Jev settings arrive here, never on argv. */
  env?: NodeJS.ProcessEnv;
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
    const input = readDecisionInput(JSON.parse(await io.readStdin()));
    // The daemon passes the instance's Jev settings through the environment
    // (never argv). With a key present the Jev policy decides; without one the
    // bundled fan-out is available only for runs without Jev assignment history.
    const jev = readJevRouterEnv(io.env ?? {});
    decision = jev
      ? await decideJevRouterAssignment({ ...input, jev })
      : decideDefaultRouterAssignment(input);
  } catch (error) {
    const env = io.env ?? {};
    const message = redactJevSecrets(error instanceof Error ? error.message : String(error), {
      proxyUrls: [env.XACPX_JEV_PROXY, env.HTTPS_PROXY, env.https_proxy],
      apiKey: env.XACPX_JEV_API_KEY,
    });
    await io.writeStderr(`[xacpx-default-router] ${message}\n`);
    return 1;
  }
  await io.writeStdout(`${JSON.stringify(decision)}\n`);
  return 0;
}

/** The Jev settings the daemon injects for `--decide`. Absent (or an empty
 *  key) means the instance has no Jev configuration, and the fan-out runs. */
export function readJevRouterEnv(env: NodeJS.ProcessEnv): JevRouterEnv | undefined {
  const apiKey = env.XACPX_JEV_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return undefined;
  return {
    endpoint: env.XACPX_JEV_ENDPOINT?.trim() || DEFAULT_JEV_ENDPOINT,
    apiKey,
    ...(env.XACPX_JEV_PROXY?.trim() ? { proxyUrl: env.XACPX_JEV_PROXY.trim() } : {}),
    model: env.XACPX_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
  };
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
    completedAssignmentTotal,
    omittedAssignmentCount,
    assignmentSequence,
    durableCollaboration,
    durableProgress,
    remainingBudget,
    leadBotId,
    publicTranscript,
    availability,
    omittedAvailabilityCount,
  } = value as Record<
    "request" | "requestMessageId" | "memberMetadata" | "completedAssignments" | "completedAssignmentTotal"
      | "omittedAssignmentCount" | "assignmentSequence" | "durableCollaboration" | "durableProgress" | "remainingBudget"
      | "leadBotId" | "publicTranscript" | "availability" | "omittedAvailabilityCount",
    unknown
  >;
  if (typeof request !== "string") {
    throw new Error("routing input requires a string request");
  }
  if (typeof requestMessageId !== "string") {
    throw new Error("routing input requires a string requestMessageId");
  }
  if (typeof remainingBudget !== "number" || !Number.isFinite(remainingBudget)) {
    throw new Error("routing input requires a numeric remainingBudget");
  }
  // The window never stands in for the Run's history: the cumulative count and
  // the durable minting sequence must arrive explicitly or the CLI fails shut.
  if (typeof completedAssignmentTotal !== "number" || !Number.isSafeInteger(completedAssignmentTotal) || completedAssignmentTotal < 0) {
    throw new Error("routing input requires a non-negative integer completedAssignmentTotal");
  }
  if (omittedAssignmentCount !== undefined
    && (typeof omittedAssignmentCount !== "number" || !Number.isSafeInteger(omittedAssignmentCount) || omittedAssignmentCount < 0)) {
    throw new Error("routing input omittedAssignmentCount must be a non-negative integer");
  }
  if (omittedAvailabilityCount !== undefined
    && (typeof omittedAvailabilityCount !== "number" || !Number.isSafeInteger(omittedAvailabilityCount) || omittedAvailabilityCount < 0)) {
    throw new Error("routing input omittedAvailabilityCount must be a non-negative integer");
  }
  if (typeof assignmentSequence !== "number" || !Number.isSafeInteger(assignmentSequence) || assignmentSequence < 0) {
    throw new Error("routing input requires a non-negative integer assignmentSequence");
  }
  if (!Array.isArray(completedAssignments)) {
    throw new Error("routing input completedAssignments must be an array");
  }
  if (!Array.isArray(memberMetadata)) {
    throw new Error("routing input memberMetadata must be an array");
  }
  const members: unknown[] = memberMetadata;
  const durable = readDurableCollaboration(durableCollaboration);
  const progress = readDurableProgress(durableProgress);
  return {
    request,
    ...((value as { requestTruncated?: unknown }).requestTruncated === true ? { requestTruncated: true as const } : {}),
    requestMessageId,
    members: members.map((entry) => readMember(entry)),
    completedAssignmentTotal,
    ...(omittedAssignmentCount !== undefined ? { omittedAssignmentCount } : {}),
    assignmentSequence,
    ...(durable !== undefined ? { durableCollaboration: durable } : {}),
    ...(progress !== undefined ? { durableProgress: progress } : {}),
    completedAssignments: readCollaborationHistory(completedAssignments),
    remainingBudget,
    ...(typeof leadBotId === "string" && leadBotId.trim().length > 0 ? { leadBotId } : {}),
    ...(Array.isArray(publicTranscript)
      ? { publicTranscript: publicTranscript.map((entry) => readTranscriptRow(entry)) }
      : {}),
    ...(availability !== undefined ? { availability: readAvailability(availability) } : {}),
    ...(omittedAvailabilityCount !== undefined ? { omittedAvailabilityCount } : {}),
  };
}

/** Durable accounting crosses the process boundary too: a malformed verdict
 *  would silently re-enable self-verification, so it is decoded field by field. */
function readDurableCollaboration(value: unknown): DurableCollaborationFacts | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("routing input durableCollaboration must be an object");
  }
  const facts = value as Record<string, unknown>;
  if (!Array.isArray(facts.producerBotIds) || facts.producerBotIds.length > MAX_ROUTER_MEMBER_METADATA
    || facts.producerBotIds.some((botId) => typeof botId !== "string" || botId.trim().length === 0)) {
    throw new Error("routing input durableCollaboration.producerBotIds must be member ids");
  }
  if (typeof facts.recoveryExhausted !== "boolean") {
    throw new Error("routing input durableCollaboration.recoveryExhausted must be a boolean");
  }
  return { producerBotIds: facts.producerBotIds as string[], recoveryExhausted: facts.recoveryExhausted };
}

/** The progress reduction crosses the process boundary too: a malformed
 *  unresolved set would let a decision read clipped rows as resolved work, so
 *  it is decoded field by field and never defaulted to empty. */
function readDurableProgress(value: unknown): DurableProgressReduction | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("routing input durableProgress must be an object");
  }
  const reduction = value as Record<string, unknown>;
  if (!Array.isArray(reduction.issues) || reduction.issues.length > MAX_DURABLE_UNRESOLVED_ISSUES) {
    throw new Error("routing input durableProgress.issues must be a bounded array");
  }
  const issues = reduction.issues.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid unresolved issue");
    const issue = entry as Record<string, unknown>;
    if (typeof issue.assignmentId !== "string" || !issue.assignmentId.trim() || issue.assignmentId.length > 128) {
      throw new Error("unresolved issue requires a durable assignment id");
    }
    if (typeof issue.botId !== "string" || !issue.botId.trim() || issue.botId.length > MAX_BOT_ID_LENGTH) {
      throw new Error("unresolved issue requires a member bot id");
    }
    if (!Number.isSafeInteger(issue.batch) || (issue.batch as number) < 1) throw new Error("invalid unresolved issue batch");
    if (issue.failureReason !== undefined
      && (typeof issue.failureReason !== "string" || issue.failureReason.length > 2_000)) {
      throw new Error("invalid unresolved issue failure reason");
    }
    return {
      assignmentId: issue.assignmentId, botId: issue.botId, batch: issue.batch as number,
      ...(issue.failureReason !== undefined ? { failureReason: issue.failureReason as string } : {}),
    };
  });
  if (!Number.isSafeInteger(reduction.total) || (reduction.total as number) < 0) {
    throw new Error("routing input durableProgress.total must be a non-negative integer");
  }
  if (reduction.omittedIssueCount !== undefined
    && (!Number.isSafeInteger(reduction.omittedIssueCount) || (reduction.omittedIssueCount as number) < 0)) {
    throw new Error("routing input durableProgress.omittedIssueCount must be a non-negative integer");
  }
  if (!Number.isSafeInteger(reduction.artifactVersion) || (reduction.artifactVersion as number) < 0) {
    throw new Error("routing input durableProgress.artifactVersion must be a non-negative integer");
  }
  if (!Number.isSafeInteger(reduction.verifiedVersion) || (reduction.verifiedVersion as number) < 0) {
    throw new Error("routing input durableProgress.verifiedVersion must be a non-negative integer");
  }
  if (!Array.isArray(reduction.producerBotIds) || reduction.producerBotIds.length > MAX_ROUTER_MEMBER_METADATA
    || reduction.producerBotIds.some((botId) => typeof botId !== "string" || !botId.trim())) {
    throw new Error("routing input durableProgress.producerBotIds must be member ids");
  }
  return {
    issues,
    total: reduction.total as number,
    ...(reduction.omittedIssueCount !== undefined ? { omittedIssueCount: reduction.omittedIssueCount as number } : {}),
    artifactVersion: reduction.artifactVersion as number,
    producerBotIds: reduction.producerBotIds as string[],
    verifiedVersion: reduction.verifiedVersion as number,
  };
}

/** The Jev policy reads role/sender/content only; a row missing any of them is
 *  unreadable, so the CLI fails closed rather than folding half a row into the
 *  model's context. */
function readTranscriptRow(value: unknown): NonNullable<DefaultRouterDecisionInput["publicTranscript"]>[number] {
  if (typeof value !== "object" || value === null) {
    throw new Error("routing input publicTranscript must contain objects");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.seq !== "number" || typeof row.content !== "string") {
    throw new Error("routing input publicTranscript entry is missing id, seq, or content");
  }
  if (row.role !== "human" && row.role !== "bot" && row.role !== "system") {
    throw new Error("routing input publicTranscript entry has an unknown role");
  }
  if (row.senderBotId !== undefined && typeof row.senderBotId !== "string") {
    throw new Error("routing input publicTranscript entry has a malformed senderBotId");
  }
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    ...(row.senderBotId !== undefined ? { senderBotId: row.senderBotId } : {}),
    ...(row.runId !== undefined ? { runId: String(row.runId) } : {}),
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

const AVAILABILITY_STATES: readonly MemberAvailability["state"][] = [
  "idle", "working", "waiting-children", "waiting-human", "unavailable",
];

/** Availability crosses the process boundary as untrusted JSON too: every
 *  field is checked, and an over-cap or malformed sample fails the CLI shut
 *  rather than presenting a partial workload picture as complete. */
function readAvailability(value: unknown): MemberAvailability[] {
  if (!Array.isArray(value) || value.length > MAX_ROUTER_AVAILABILITY_MEMBERS) {
    throw new Error(`routing input availability must be an array of at most ${MAX_ROUTER_AVAILABILITY_MEMBERS} members`);
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("routing input availability must contain objects");
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.botId !== "string" || row.botId.trim().length === 0) {
      throw new Error("routing input availability entry requires a non-empty botId");
    }
    if (!AVAILABILITY_STATES.includes(row.state as MemberAvailability["state"])) {
      throw new Error("routing input availability entry has an unknown state");
    }
    for (const field of ["activeAssignments", "pendingAssignments"] as const) {
      const count = row[field];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`routing input availability entry requires a non-negative integer ${field}`);
      }
    }
    if (typeof row.quarantinedForRun !== "boolean") {
      throw new Error("routing input availability entry requires a boolean quarantinedForRun");
    }
    if (typeof row.sampledAt !== "string" || row.sampledAt.trim().length === 0) {
      throw new Error("routing input availability entry requires a non-empty sampledAt");
    }
    return {
      botId: row.botId,
      state: row.state as MemberAvailability["state"],
      activeAssignments: row.activeAssignments as number,
      pendingAssignments: row.pendingAssignments as number,
      quarantinedForRun: row.quarantinedForRun,
      sampledAt: row.sampledAt,
    };
  });
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
