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
 * Everything a plugin RECEIVES is deeply readonly, and that is a security
 * contract rather than a style choice: core validates answers against a
 * private snapshot, and the presentation copy handed to the renderer is
 * recursively frozen at runtime. A renderer that sorts or filters in place
 * would throw in production, so the types refuse it at compile time.
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
      readonly format?: "email" | "uri" | "date" | "date-time";
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
      readonly format?: "email" | "uri" | "date" | "date-time";
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
  /** The authenticated initiator of the exact prompt turn. */
  readonly requester: {
    readonly senderId: string;
    readonly senderName?: string;
    readonly isOwner?: boolean;
  };
  /** Additive presentation metadata; never authoritative. */
  readonly agent?: {
    readonly name?: string;
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
 * `content` is a fresh object the plugin owns: core deep-copies every value
 * (including arrays) into its own null-prototype dictionary, so a retained
 * reference cannot be mutated after validation.
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

/** ACP elicitation modes. v1 supports form only; url is never advertised. */
export type ChannelElicitationMode = "form" | "url";

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
   * settle exactly once (first terminal decision wins). Implementations
   * MUST:
   *   - render the form only for `request.requester.senderId`;
   *   - return the platform-authenticated responder id, never a self-reported
   *     payload id (roadmap §5.7);
   *   - keep pending form state in server-side memory only, never encode
   *     answer values into control ids/URLs, and never persist answers;
   *   - treat `request.fields` as read-only — it is frozen at runtime;
   *   - settle within `expiresAt` / on `signal` abort by returning
   *     `{ action: "cancel", responderId }`.
   */
  requestElicitation?(
    request: ChannelElicitationRequest,
  ): Promise<ChannelElicitationDecision>;
}
