import { RoutingDecisionError, isRouterCapabilityRestricted, parseRoutingDecision } from "./conversation-router-types";
import type { ConversationRouter, RoutingDecision, RoutingInput, RoutingMember } from "./conversation-router-types";
import { MAX_GROUP_TARGET_MEMBERS, MAX_BOT_ID_LENGTH } from "@ganglion/xacpx-relay-protocol";

/** Result of the decision gate. Either a validated decision, or a fail-closed
 *  classification of the whole Run (Router failure is a Run failure, never a
 *  silently dropped batch). */
export type RoutingGateResult =
  | { kind: "decision"; decision: RoutingDecision }
  | { kind: "rejected"; code: string; message: string };

/**
 * PR8 router-decision gate (design §12.1/§12.2, plan §11.2/§11.3).
 *
 * Two layers, both fail-closed:
 *
 * 1. STRUCTURE — `parseRoutingDecision` decodes strictly; malformed shapes,
 *    unknown types, over-long fields, and non-string ids never enter the
 *    domain and never default, coerce, or repair.
 * 2. DOMAIN — the decision must map onto the CURRENT Run: every assignment id
 *    unique within the decision, every botId a live member (unknown or
 *    non-member Bots are rejected), `dependsOn` resolvable inside the same
 *    decision or against durable prior assignments of this Run, and the batch
 *    size plus `maxMemberTurns` budget honored.
 *
 * `triggerMessageIds` are NOT restricted to the Router's transcript: they are
 * the exact public message boundary this assignment reacts to, and the caller
 * verifies each id is a real public row of THIS Conversation+Topic before the
 * durable write (see ConversationRunService). A Router cannot invent messages.
 */
export function validateRoutingDecision(decision: RoutingDecision, input: RoutingInput): void {
  if (decision.type !== "dispatch") {
    return;
  }
  const memberByBotId = new Map(input.memberMetadata.map((member) => [member.botId, member]));
  const decisionIds = new Set<string>();
  const priorAssignmentIds = new Set(input.completedAssignments.map((assignment) => assignment.id));
  for (const assignment of decision.assignments) {
    if (decisionIds.has(assignment.id) || priorAssignmentIds.has(assignment.id)) {
      throw new RoutingDecisionError(
        "router_assignment_duplicate",
        `Router assigns duplicate assignment id "${assignment.id}"`,
        { assignmentId: assignment.id },
      );
    }
    decisionIds.add(assignment.id);
    if (assignment.botId.length > MAX_BOT_ID_LENGTH) {
      throw new RoutingDecisionError(
        "router_unknown_member",
        `Router assignment "${assignment.id}" botId exceeds the maximum id length`,
      );
    }
    const member = memberByBotId.get(assignment.botId);
    if (!member) {
      throw new RoutingDecisionError(
        "router_unknown_member",
        `Router assignment "${assignment.id}" targets bot "${assignment.botId}" which is not a member of conversation "${input.conversationId}"`,
        { botId: assignment.botId, assignmentId: assignment.id },
      );
    }
    if (!member.enabled) {
      throw new RoutingDecisionError(
        "router_member_unavailable",
        `Router assignment "${assignment.id}" targets disabled bot "${assignment.botId}"`,
        { botId: assignment.botId, assignmentId: assignment.id },
      );
    }
    for (const dependency of assignment.dependsOn ?? []) {
      // A dependency may name an assignment in the same decision (chained
      // sequential work) or a durable assignment of this Run. Cross-Run and
      // unknown dependencies are refused: the Router cannot reach outside
      // the Run it was asked about.
      if (dependency === assignment.id) {
        throw new RoutingDecisionError(
          "router_assignment_dependency_cycle",
          `Router assignment "${assignment.id}" depends on itself`,
        );
      }
      if (decisionIds.has(dependency) || priorAssignmentIds.has(dependency)) {
        continue;
      }
      // Forward references inside the decision are also cycles unless the
      // graph is acyclic; a strict topological check below catches them.
      const forward = decision.assignments.some((other) => other.id === dependency);
      if (forward) {
        continue;
      }
      throw new RoutingDecisionError(
        "router_assignment_dependency_unknown",
        `Router assignment "${assignment.id}" depends on unknown assignment "${dependency}"`,
        { dependency, assignmentId: assignment.id },
      );
    }
  }
  // Dependency graph must be acyclic and `single`/`parallel` batches may not
  // carry dependencies at all: a dependency makes the batch ordered by
  // definition, and pretending single/parallel work is ordered would break
  // the frozen-snapshot contract.
  const dependsAll = decision.assignments.some((assignment) => (assignment.dependsOn ?? []).length > 0);
  if (dependsAll && decision.mode !== "sequential") {
    throw new RoutingDecisionError(
      "router_assignment_dependency_mode",
      `Router dependencies require mode "sequential", got "${decision.mode}"`,
      { mode: decision.mode },
    );
  }
  if (decision.mode === "single" && decision.assignments.length !== 1) {
    throw new RoutingDecisionError(
      "router_assignment_mode",
      `Router dispatch mode "single" carries ${decision.assignments.length} assignments`,
    );
  }
  if (decision.mode === "parallel" && decision.assignments.length < 2) {
    throw new RoutingDecisionError(
      "router_assignment_mode",
      'Router dispatch mode "parallel" requires at least two independent assignments',
    );
  }
  const namedBotIds = new Set(decision.assignments.map((assignment) => assignment.botId));
  if (namedBotIds.size !== decision.assignments.length) {
    throw new RoutingDecisionError(
      "router_assignment_duplicate_member",
      "Router dispatch names the same Bot twice in one batch",
    );
  }
  if (namedBotIds.size > MAX_GROUP_TARGET_MEMBERS) {
    throw new RoutingDecisionError(
      "router_dispatch_too_large",
      `Router dispatch selects more than ${MAX_GROUP_TARGET_MEMBERS} members`,
    );
  }
  if (input.remainingBudget < decision.assignments.length) {
    throw new RoutingDecisionError(
      "router_budget_exhausted",
      `Router dispatch needs ${decision.assignments.length} member turns but only ${input.remainingBudget} remain`,
      {
        requested: decision.assignments.length,
        remaining: input.remainingBudget,
      },
    );
  }
}

/** Cycle detector over the decision's own dependency edges. */
function hasDependencyCycle(assignments: Extract<RoutingDecision, { type: "dispatch" }>["assignments"]): boolean {
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    for (const dep of byId.get(id) ?? []) {
      if (byId.has(dep) && walk(dep)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return assignments.some((assignment) => walk(assignment.id));
}

/**
 * Full gate used by the Run service: decode strictly, then domain-check
 * against the live input. A Router implementation that cannot prove its
 * capability restriction never reaches this gate — the service refuses the
 * configuration before invoking `decide`.
 */
export function gateRoutingDecision(
  decision: unknown,
  input: RoutingInput,
): RoutingGateResult {
  let parsed: RoutingDecision;
  try {
    parsed = parseRoutingDecision(decision);
  } catch (error) {
    if (error instanceof RoutingDecisionError) {
      return { kind: "rejected", code: error.code, message: error.message };
    }
    throw error;
  }
  try {
    validateRoutingDecision(parsed, input);
    if (parsed.type === "dispatch" && hasDependencyCycle(parsed.assignments)) {
      return {
        kind: "rejected",
        code: "router_assignment_dependency_cycle",
        message: "Router dispatch contains a cyclic dependency graph",
      };
    }
    return { kind: "decision", decision: parsed };
  } catch (error) {
    if (error instanceof RoutingDecisionError) {
      return { kind: "rejected", code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * Decode an arbitrary Thrower-provided Router into the ConversationRouter
 * contract. Anything that is not an object with a `decide` function and a
 * fully restricted capability declaration is NOT a Router — it cannot be
 * wired into automatic mode.
 */
export function bindRouter(router: unknown): ConversationRouter | undefined {
  if (!router || typeof router !== "object") {
    return undefined;
  }
  const candidate = router as Partial<ConversationRouter>;
  if (typeof candidate.decide !== "function") {
    return undefined;
  }
  if (!isRouterCapabilityRestricted(candidate.capabilityRestriction)) {
    return undefined;
  }
  return {
    capabilityRestriction: candidate.capabilityRestriction,
    decide: (input) => candidate.decide!(input),
  };
}
