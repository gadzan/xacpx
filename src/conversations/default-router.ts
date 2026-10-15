import { fileURLToPath } from "node:url";

import {
  MAX_ROUTER_ASSIGNMENTS_PER_DECISION,
  MAX_ROUTER_ASSIGNMENT_ID_LENGTH,
  MAX_ROUTER_TASK_LENGTH,
  type RouterCapabilityRestriction,
  type RoutingDecision,
  type RoutingMember,
} from "./conversation-router-types";
import {
  DEFAULT_JEV_ENDPOINT,
  DEFAULT_JEV_MODEL,
  JEV_ROUTER_QUESTION,
  MAX_JEV_CHOICES,
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
 * Confidence floor for a Jev pick. Below it the model is guessing, so the
 * policy falls back to the Group's lead instead of dispatching on a coin flip.
 */
export const JEV_MIN_CONFIDENCE = 0.6;

/** Bound on the transcript block folded into the Jev state message. */
const JEV_CONTEXT_CHARACTERS = 2_000;
const JEV_CONTEXT_ROWS = 6;
const JEV_CONTEXT_ROW_CHARACTERS = 400;

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

/** Best available description for one member. RoutingMember carries no Bot
 *  instruction text (that is execution configuration, not routing evidence);
 *  the role is the closest thing to a profile, the name the fallback. */
function memberDescription(member: RoutingMember): string {
  const role = member.role?.trim();
  if (role) return role;
  const name = member.name.trim();
  return name.length > 0 ? name : member.botId;
}

/** Bounded newest-first transcript block for the Jev state message. */
function recentContext(input: DefaultRouterDecisionInput): string {
  const rows = (input.publicTranscript ?? []).slice(0, JEV_CONTEXT_ROWS);
  if (rows.length === 0) return "";
  const lines: string[] = [];
  let left = JEV_CONTEXT_CHARACTERS;
  for (const row of rows) {
    const content = row.content.slice(0, Math.min(JEV_CONTEXT_ROW_CHARACTERS, left));
    left -= content.length;
    if (content.length === 0) break;
    const speaker = row.role === "bot" ? (row.senderBotId ?? "bot") : row.role;
    lines.push(`${speaker}: ${content}`);
    if (left <= 0) break;
  }
  return lines.join("\n");
}

/** The single-assignment dispatch for one chosen member. */
function dispatchTo(
  member: RoutingMember,
  input: DefaultRouterDecisionInput,
  reason: string,
): RoutingDecision {
  const qualifiedId = `jev-0-${member.botId}`;
  return {
    type: "dispatch",
    mode: "single",
    assignments: [{
      id: qualifiedId.length <= MAX_ROUTER_ASSIGNMENT_ID_LENGTH ? qualifiedId : "jev-0",
      botId: member.botId,
      task: input.request.trim().slice(0, MAX_ROUTER_TASK_LENGTH),
      triggerMessageIds: input.requestMessageId.length > 0 ? [input.requestMessageId] : [],
    }],
    reason,
  };
}

/**
 * The Jev routing policy: ask the model to pick ONE enabled member, dispatch
 * only to it, and fall back to the Group lead (else the first enabled member)
 * whenever the pick is untrustworthy.
 *
 * The guard order is the same contract as the fan-out: an empty request asks a
 * human, nobody enabled completes, an exhausted budget completes, and a Run
 * that already spent a round completes instead of looping.
 *
 * A decision always carries a human-readable `reason` — who was dispatched to,
 * why, and the confidence (or the fallback cause) — because the UI renders it
 * verbatim.
 */
export async function decideJevRouterAssignment(
  input: JevRouterDecisionInput,
  ask: JevAskFn = realJevAsk,
): Promise<RoutingDecision> {
  const request = input.request.trim();
  if (request.length === 0) {
    return { type: "need-human", question: "The run request is empty." };
  }
  const enabled = input.members.filter((member) => member.enabled);
  if (enabled.length === 0) {
    return { type: "complete", reason: "No enabled group members are available to assign." };
  }
  if (input.remainingBudget <= 0) {
    return { type: "complete", reason: "The member turn budget is exhausted." };
  }
  if (input.completedAssignmentCount > 0) {
    return { type: "complete", reason: "The router assigns one round per run." };
  }
  const fallback = (cause: string): RoutingDecision => {
    const lead = input.leadBotId === undefined
      ? undefined
      : enabled.find((member) => member.botId === input.leadBotId);
    const target = lead ?? enabled[0]!;
    const why = lead
      ? "the group lead"
      : input.leadBotId === undefined
        ? "the first enabled member (no group lead is configured)"
        : "the first enabled member (the group lead is not enabled)";
    return dispatchTo(
      target,
      input,
      `Jev could not decide (${cause}); dispatched to ${why} ${target.botId}.`,
    );
  };
  const choices: JevChoice[] = enabled.slice(0, MAX_JEV_CHOICES).map((member) => ({
    key: member.botId,
    description: memberDescription(member),
  }));
  const context = recentContext(input);
  const message = context.length > 0 ? `${request}\n\nRecent context:\n${context}` : request;
  let answer: JevAskResult;
  try {
    answer = await ask({
      endpoint: input.jev.endpoint,
      apiKey: input.jev.apiKey,
      ...(input.jev.proxyUrl ? { proxyUrl: input.jev.proxyUrl } : {}),
      model: input.jev.model,
      message,
      question: JEV_ROUTER_QUESTION,
      choices,
    });
  } catch (error) {
    // The reason is user-visible (Run card) and durable: never let a proxy
    // credential or the key ride along in a thrown transport message.
    const detail = redactJevSecrets(error instanceof Error ? error.message : String(error), {
      proxyUrls: [input.jev.proxyUrl, process.env.HTTPS_PROXY, process.env.https_proxy],
      apiKey: input.jev.apiKey,
    });
    return fallback(`the router call failed: ${detail}`);
  }
  if (!answer.ok) {
    return fallback(`the router call failed: ${answer.code}`);
  }
  const picked = enabled.find((member) => member.botId === answer.choice);
  if (!picked) {
    return fallback(`the router named an unknown member "${answer.choice}"`);
  }
  if (answer.confidence < JEV_MIN_CONFIDENCE) {
    return fallback(`low confidence ${answer.confidence.toFixed(2)}`);
  }
  return dispatchTo(
    picked,
    input,
    `Jev dispatched to ${picked.botId} (confidence ${answer.confidence.toFixed(2)}).`,
  );
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
    // bundled fan-out keeps working, so an unconfigured instance degrades to
    // the old behavior instead of failing the Run.
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
    remainingBudget,
    leadBotId,
    publicTranscript,
  } = value as Record<
    "request" | "requestMessageId" | "memberMetadata" | "completedAssignments" | "remainingBudget" | "leadBotId" | "publicTranscript",
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
    ...(typeof leadBotId === "string" && leadBotId.trim().length > 0 ? { leadBotId } : {}),
    ...(Array.isArray(publicTranscript)
      ? { publicTranscript: publicTranscript.map((entry) => readTranscriptRow(entry)) }
      : {}),
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
