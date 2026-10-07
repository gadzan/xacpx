import { ConversationError } from "./conversation-error";

// This vocabulary belongs to external admission, never to an adapter's Runtime
// error guessing. Unknown/corrupt/storage failures are deliberately absent.
const REJECTION_CODES = new Set([
  "binding_changed", "binding_topic_invalid", "external_request_conflict", "external_request_retired",
  "external_group_unsupported", "external_human_required", "external_media_unsupported",
  "external_ingress_invalid", "external_target_ambiguous", "external_target_invalid",
  "external_target_required", "external_target_changed", "external_target_unavailable",
  "external_queue_full", "external_routing_unsupported", "external_stop_unavailable", "external_request_aborted",
]);

export function isExternalIngressRejectionCode(code: string): boolean { return REJECTION_CODES.has(code); }

const DURABLE_INGRESS_REJECTION = Symbol.for("@ganglion/xacpx/conversation-ingress-rejection");

/** Only issued after durable source evidence exists; safe to acknowledge ingress. */
export class ConversationIngressRejection extends ConversationError {
  readonly [DURABLE_INGRESS_REJECTION] = true;
}

/** Stable across separately bundled plugin/core copies; error codes alone are not proof. */
export function isConversationIngressRejection(error: unknown): error is ConversationIngressRejection {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as ConversationIngressRejection;
  return candidate[DURABLE_INGRESS_REJECTION] === true && typeof candidate.code === "string"
    && isExternalIngressRejectionCode(candidate.code) && typeof candidate.message === "string";
}
