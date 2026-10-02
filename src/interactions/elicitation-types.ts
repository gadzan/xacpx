/**
 * Plugin-facing Elicitation contract (M1, channel-neutral).
 *
 * Core owns the schema. Channel plugins never see ACP SDK types: the ACP
 * `elicitation/create` form JSON Schema is normalized by core into the
 * stable field model below, and the plugin returns a validated decision.
 *
 * Every member is additive and optional — a plugin that does not implement
 * `requestElicitation` declares no capability and core fails closed with
 * `cancel`, never a crash and never a guessed answer.
 *
 * Everything in the FORM PRESENTATION graph a plugin receives is deeply
 * readonly, and that is a security contract rather than a style choice: core
 * validates answers against a private snapshot, and the presentation copy
 * handed to the renderer is recursively frozen at runtime. A renderer that
 * sorts or filters `fields` in place would throw in production, so the types
 * refuse it at compile time.
 *
 * The freeze is scoped to that graph — `form.fields`, each field, its
 * `options`, and a multi-select `defaultValue`. The request WRAPPER
 * (`requester`, `agent`, `signal`, ...) is NOT frozen: authentication reads
 * core's private route rather than the plugin-visible copy, so freezing the
 * wrapper would add nothing. Do not claim more than that in prose.
 */

/** Values the ACP form protocol can carry for a single field. */
export type ChannelElicitationValue =
  | string
  | number
  | boolean
  | string[];

export interface ChannelElicitationOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type ChannelElicitationField =
  | {
      readonly kind: "text";
      readonly key: string;
      readonly title: string;
      readonly description?: string;
      readonly required: boolean;
      readonly defaultValue?: string;
      readonly minLength?: number;
      readonly maxLength?: number;
      /** Display metadata only: core never executes agent-provided patterns. */
      readonly pattern?: string;
      /**
       * String `format` from the agent's schema.
       *
       * `email | uri | date | date-time` are the ACP KNOWN formats and core
       * validates answers against them. ANY other value is an ACP annotation:
       * the RFD requires clients to preserve unknown formats, so core carries it
       * through for the renderer to interpret and never rejects the form for it.
       */
      readonly format?: string;
    }
  | {
      readonly kind: "single-select";
      readonly key: string;
      readonly title: string;
      readonly description?: string;
      readonly required: boolean;
      readonly options: readonly ChannelElicitationOption[];
      readonly defaultValue?: string;
      /**
       * String constraints the agent attached alongside the enum. ACP allows
       * them to coexist, and dropping them would let an answer the agent's
       * own schema rejects reach it as accepted. Core re-validates them.
       */
      readonly minLength?: number;
      readonly maxLength?: number;
      /**
       * Same contract as the text field: ACP known formats are validated, any
       * other value is a preserved annotation.
       */
      readonly format?: string;
      /** Display metadata only: core never executes agent-provided patterns. */
      readonly pattern?: string;
    }
  | {
      readonly kind: "number";
      readonly key: string;
      readonly title: string;
      readonly description?: string;
      readonly required: boolean;
      readonly integer: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly defaultValue?: number;
    }
  | {
      readonly kind: "boolean";
      readonly key: string;
      readonly title: string;
      readonly description?: string;
      readonly required: boolean;
      readonly defaultValue?: boolean;
    }
  | {
      readonly kind: "multi-select";
      readonly key: string;
      readonly title: string;
      readonly description?: string;
      readonly required: boolean;
      readonly options: readonly ChannelElicitationOption[];
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly defaultValue?: readonly string[];
    };

export interface ChannelElicitationRequest {
  /** xacpx broker correlation id (ephemeral; never persisted). */
  readonly requestId: string;
  readonly chatKey: string;
  readonly accountId?: string;
  readonly replyContextToken?: string;
  /**
   * Whether this turn's destination is provably 1:1, as reported by the channel's
   * own ingress metadata.
   *
   * A form renders the agent's question AND the user's answers into the chat, so
   * this is a PRIVACY input, not a presentation one: only a `direct` destination
   * is provably visible to the requester alone. `undefined` — the channel said
   * nothing — is NOT the same as `direct` and must be treated as not provably
   * private, because a channel that does not report it here is a channel whose
   * route the renderer cannot vouch for.
   *
   * Renderers MUST refuse a form whose `chatType` is not `"direct"`.
   */
  readonly chatType?: "direct" | "group";
  /** The authenticated initiator of the exact prompt turn. */
  readonly requester: {
    readonly senderId: string;
    readonly senderName?: string;
    readonly isOwner?: boolean;
  };
  /**
   * The Agent requesting information, pinned to the exact turn that caused
   * this elicitation.
   *
   * ACP User Interaction Requirements oblige the client to clearly identify
   * the requesting Agent, so `name` is REQUIRED and core fails closed when it
   * cannot establish it. Renderers MUST display it and MUST NOT substitute
   * `message`/`title`/`description` text for identity — that text is
   * agent-controlled.
   */
  readonly agent: {
    readonly name: string;
    readonly sessionAlias?: string;
  };
  readonly message: string;
  readonly mode: "form";
  readonly fields: readonly ChannelElicitationField[];
  /** ACP schema-level presentation metadata, bounded by core. */
  readonly schemaTitle?: string;
  readonly schemaDescription?: string;
  readonly expiresAt: number;
  /** Aborts on timeout, turn disposal, or shutdown. */
  readonly signal: AbortSignal;
}

/**
 * Terminal decision. `responderId` MUST be the platform-authenticated
 * identity of whoever activated the control; core re-verifies it against
 * the exact turn initiator and never trusts self-reported payload ids.
 *
 * WHO CAN PRODUCE WHICH ACTION IS PART OF THE CONTRACT, not a style choice:
 *
 *   accept  — user reviewed the form, optionally edited answers, and submitted
 *   decline — user explicitly signalled "I won't answer"
 *   cancel  — user dismissed / abandoned the form
 *
 * EVERY member of this union is a USER action and therefore REQUIRES
 * `responderId`. There is deliberately no responder-free variant.
 *
 * Externally-forced cancellation (timeout, turn disposal, agent
 * `$/cancel_request`, shutdown) is NOT a user decision and is NOT part of this
 * union: core owns those paths and settles them itself, before or racing any
 * renderer return. A renderer never reports an external abort as a decision.
 *
 * Round 14 briefly added a `{ action: "cancel" }` withdrawal variant; round 15
 * reverted it, because that variant was reachable only on a LIVE request (a
 * real abort settles first, via the `aborted` race or the post-decision
 * `signal.aborted` check), so its only effect was to let a renderer or
 * control-path bug settle a user `cancel` without the authenticated responder
 * that a user dismissal must carry. Fail-closed result, bypassed actor.
 */
export type ChannelElicitationDecision =
  | {
      action: "accept";
      responderId: string;
      /**
       * Matches the internal broker result and the runtime decision:
       * `null` is a valid ACP accept for an all-optional form, and `undefined`
       * means the channel submitted nothing at all (core then validates the
       * empty set). A channel that cannot express "no answers" has no way to
       * render a zero-field form correctly.
       */
      content?: Record<string, ChannelElicitationValue> | null;
    }
  | {
      action: "decline" | "cancel";
      responderId: string;
    };

/**
 * Elicitation modes a plugin may declare.
 *
 * `"form"` ONLY in M1. ACP itself defines `form | url`, but xacpx has no URL
 * renderer contract: `ChannelElicitationRequest` carries form data only, there
 * is no URL dispatch, and the RFD's URL-mode rules (display the target host,
 * obtain consent before navigating, `elicitationId`, `elicitation/complete`)
 * are unimplemented. Declaring `"url"` here would advertise a capability core
 * cannot deliver, so the plugin-facing union is deliberately narrower than the
 * ACP one. Widen when M2 ships URL rendering.
 */
export type ChannelElicitationMode = "form";

/**
 * Runtime-visible channel Elicitation interface (M1 steps 6/7 shape,
 * plugin-facing core-owned types).
 */
export interface MessageChannelElicitationRuntime {
  /**
   * Modes this channel can actually render. Only modes listed here AND
   * backed by a real `requestElicitation` implementation are advertised by
   * the core capability probe; absence never implies form support.
   */
  readonly elicitationModes?: readonly ChannelElicitationMode[];

  /**
   * Render a form Elicitation for the authenticated turn initiator and
   * settle exactly once (first terminal decision wins).
   *
   * ACP User Interaction Requirements (pinned
   * `docs/rfds/elicitation.mdx`) that this contract MUST enforce, because
   * core cannot enforce them itself:
   *
   *   - render the form only for `request.requester.senderId`;
   *   - return the platform-authenticated responder id, never a self-reported
   *     payload id (roadmap §5.7);
   *   - display `request.agent.name` and MUST NOT substitute
   *     `message`/`title`/`description` text for identity — that text is
   *     agent-controlled;
   *   - **present `request.message`** (ACP SHOULD). Dropping it hides what the
   *     agent is actually asking;
   *   - **expose clear, separate Decline and Cancel controls** (ACP MUST).
   *     These are user actions and therefore carry an authenticated
   *     `responderId`, exactly like `accept`;
   *   - **let the user review and modify responses before sending** (ACP
   *     MUST). A submit control that commits an uneditable pre-filled value
   *     is not compliant;
   *   - keep pending form state in server-side memory only, never encode
   *     answer values into control ids/URLs, and never persist answers;
   *   - treat `request.fields` as read-only — it is frozen at runtime.
   *
   * Cancellation is split by origin, and a renderer must not conflate them:
   *
   *   - user dismisses → return `{ action: "cancel", responderId }`;
   *   - user declines → return `{ action: "decline", responderId }`;
   *   - on `request.signal` abort (timeout, turn disposal, agent
   *     `$/cancel_request`, shutdown) → **withdraw/disable your UI IMMEDIATELY
   *     and stop collecting input.** An external abort is not a user decision,
   *     so it is NOT a member of `ChannelElicitationDecision`: do not return
   *     one, and do not invent a `responderId` for a cancellation the user did
   *     not cause. Reject/throw the promise instead (or simply never settle it)
   *     and let core finish — core's abort race and the post-decision checks
   *     settle the request as `cancel` either way.
   */
  requestElicitation?(
    request: ChannelElicitationRequest,
  ): Promise<ChannelElicitationDecision>;
}
