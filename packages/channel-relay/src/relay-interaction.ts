/**
 * Wire mapping + outcome parsing for the relay interaction transport.
 *
 * Kept separate from `channel.ts` because two different trust boundaries meet
 * here and the file that owns one should not also own the other's translation:
 *
 *   outbound — core's normalized `ChannelElicitationRequest` becomes the one
 *     wire frame. Core is the authority on WHAT is being asked (it froze and
 *     deep-cloned the form), so this is a field-for-field projection with no
 *     interpretation of content: no re-validation, no defaults, no coercion.
 *
 *   inbound — the hub's answer becomes the channel's terminal decision. The hub
 *     is the authority on WHO answered (it stamps the responder from its own
 *     authenticated session), so this only checks the frame is well-formed and
 *     inverts the mapping. Identity is never read here and never derived here.
 *
 * The one deliberate asymmetry: an out-of-union action or a missing/malformed
 * response is `cancel`, not an error throw. A renderer cannot manufacture a
 * decision, so an unparseable answer has exactly one honest reading — "the human
 * never gave a usable decision" — and the caller reports it as such.
 */

import {
  type InteractionRequestDto,
  type InteractionResponseDto,
  validateInteractionResponse,
} from "@ganglion/xacpx-relay-protocol";
import type {
  ChannelElicitationField,
  ChannelElicitationOption,
} from "xacpx/plugin-api";

/**
 * Project core's normalized fields onto the wire model.
 *
 * Core already bounded everything (lengths, option counts, kinds) and handed the
 * channel a deep-frozen clone, so this is a field-for-field copy. Narrowing by
 * `kind` is what keeps it that: projection is the only operation, and a shared
 * copy loop would need a cast that could silently drop a constraint the agent's
 * schema carries.
 *
 * `defaultValue` and the select `options` are copied into fresh mutable arrays:
 * the wire DTOs are mutable (they are decoded JSON on the far side), while core's
 * graph is frozen. Copying, not sharing — sharing would hand a frozen array to a
 * consumer that may sort or filter it.
 *
 * Returns `null` for a field kind this build does not model. Core validates
 * against a fixed union that matches the wire's, so null means the two drifted;
 * silently dropping the field would show the user a form the agent never asked,
 * and sending it anyway would make the hub reject the whole frame. The caller
 * closes the interaction instead.
 */
export function relayFieldsFrom(
  fields: readonly ChannelElicitationField[],
): NonNullable<InteractionRequestDto["elicitation"]>["fields"] | null {
  const wire: NonNullable<InteractionRequestDto["elicitation"]>["fields"] = [];
  for (const field of fields) {
    const base = {
      key: field.key,
      title: field.title,
      ...(field.description !== undefined ? { description: field.description } : {}),
      required: field.required,
    };
    switch (field.kind) {
      case "text":
        wire.push({
          ...base,
          kind: "text",
          ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
          ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
          ...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
          ...(field.format !== undefined ? { format: field.format } : {}),
        });
        break;
      case "single-select":
        wire.push({
          ...base,
          kind: "single-select",
          options: relayOptionsFrom(field.options),
          ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
          ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
          ...(field.format !== undefined ? { format: field.format } : {}),
          ...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
        });
        break;
      case "number":
        wire.push({
          ...base,
          kind: "number",
          integer: field.integer,
          ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
          ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
          ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
        });
        break;
      case "boolean":
        wire.push({
          ...base,
          kind: "boolean",
          ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
        });
        break;
      case "multi-select":
        wire.push({
          ...base,
          kind: "multi-select",
          options: relayOptionsFrom(field.options),
          ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
          ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
          ...(field.defaultValue !== undefined ? { defaultValue: [...field.defaultValue] } : {}),
        });
        break;
      default:
        return null;
    }
  }
  return wire;
}

function relayOptionsFrom(
  options: readonly ChannelElicitationOption[],
): NonNullable<NonNullable<InteractionRequestDto["elicitation"]>["fields"][number]["options"]> {
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
  }));
}

/**
 * The two shapes a hub can answer an opened interaction with.
 *
 * `response` is the validator's own shape PLUS the identity the hub stamped:
 * the wire DTO intentionally has no `responderId` (a browser must not supply
 * one), so it is added here rather than being smuggled onto the DTO.
 */
export type RelayInteractionOutcome =
  | { responded: true; response: InteractionResponseDto & { responderId: string } }
  | { responded: false; reason: string };

/**
 * Interpret the hub's RPC result.
 *
 * `responded: false` means the window closed without a user decision — timeout,
 * unsupported renderer, connector withdrawal. It is preserved as a distinct
 * outcome rather than folded into "answered", because the caller must turn it
 * into an abort that the agent sees, and never into a decline the user never
 * chose. The reason string is passed through for the log.
 *
 * A malformed success is treated as a close: there is no decision to hand back,
 * and inventing one is the failure mode this whole transport exists to avoid.
 */
export function parseRelayInteractionOutcome(value: unknown): RelayInteractionOutcome {
  if (typeof value !== "object" || value === null) {
    return { responded: false, reason: "aborted" };
  }
  const outcome = value as Record<string, unknown>;
  if (outcome.responded !== true) {
    const reason = typeof outcome.reason === "string" && outcome.reason.length > 0
      ? outcome.reason
      : "aborted";
    return { responded: false, reason };
  }
  const response: unknown = outcome.response;
  if (typeof response !== "object" || response === null) {
    return { responded: false, reason: "aborted" };
  }
  const frame = response as Record<string, unknown>;
  // Re-validate through the protocol's own validator rather than trusting the
  // shape: this frame crossed a network boundary, and the hub may be an older
  // build. Everything the validator rejects — an out-of-union action, an
  // unbounded answer — is a close, not a decision, because a frame that cannot
  // be validated cannot be acted on. A `permission` answer is likewise not an
  // answer to an elicitation.
  if (frame.kind !== "elicitation") {
    return { responded: false, reason: "aborted" };
  }
  //
  // The identity is handled differently on this side, and deliberately so. The
  // VALIDATOR's no-identity rule governs the browser → hub frame, where a
  // client-supplied identity must be refused because the hub has not
  // authenticated it yet. What arrives HERE is the hub → connector RESULT, and
  // the hub has already stamped the responder from its own authenticated
  // session, so the field is expected.
  //
  // Validating the frame as-is would therefore reject every honest hub. The fix
  // is to strip the identity, validate what remains against the browser rule,
  // and then read the stripped identity back — never let the unvalidated frame
  // reach the caller, and never treat the hub's stamp as a violation.
  const stamped = readIdentity(frame);
  if (stamped === undefined) {
    // The hub did not stamp one. Core refuses a decision with no authenticated
    // responder, so this is a close rather than a cancelled decision.
    return { responded: false, reason: "aborted" };
  }
  const replay: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(frame)) {
    if (key === "responderId" || key === "senderId" || key === "userId") continue;
    replay[key] = fieldValue;
  }
  // Validated by the protocol's own rule, so the cast below is over a frame the
  // validator has already accepted rather than over an untrusted shape.
  const validated = validateInteractionResponse(replay);
  if (validated === null) {
    return { responded: false, reason: "aborted" };
  }
  return {
    responded: true,
    response: { ...validated, responderId: stamped },
  };
}

/**
 * The hub-stamped responder identity, or `undefined` when the hub omitted it.
 *
 * `responderId` is the only accepted name: it is the one `interactionResultForBrowser`
 * writes, and accepting alternates here would widen what a hub bug or an older
 * build could smuggle through under a name this channel happens to still check.
 */
function readIdentity(response: Record<string, unknown>): string | undefined {
  const identity = response.responderId;
  return typeof identity === "string" && identity.length > 0 ? identity : undefined;
}
