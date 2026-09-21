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
 */

/** Values the ACP form protocol can carry for a single field. */
export type ChannelElicitationValue =
  | string
  | number
  | boolean
  | string[];

export interface ChannelElicitationOption {
  value: string;
  label: string;
  description?: string;
}

export type ChannelElicitationField =
  | {
      kind: "text";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      defaultValue?: string;
      minLength?: number;
      maxLength?: number;
      /** Display metadata only: core never executes agent-provided patterns. */
      pattern?: string;
      format?: "email" | "uri" | "date" | "date-time";
    }
  | {
      kind: "single-select";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      options: ChannelElicitationOption[];
      defaultValue?: string;
      /**
       * String constraints the agent attached alongside the enum. ACP allows
       * them to coexist, and dropping them would let an answer the agent's
       * own schema rejects reach it as accepted. Core re-validates them.
       */
      minLength?: number;
      maxLength?: number;
      format?: "email" | "uri" | "date" | "date-time";
    }
  | {
      kind: "number";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      integer: boolean;
      minimum?: number;
      maximum?: number;
      defaultValue?: number;
    }
  | {
      kind: "boolean";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      defaultValue?: boolean;
    }
  | {
      kind: "multi-select";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      options: ChannelElicitationOption[];
      minItems?: number;
      maxItems?: number;
      defaultValue?: string[];
    };

export interface ChannelElicitationRequest {
  /** xacpx broker correlation id (ephemeral; never persisted). */
  requestId: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  /** The authenticated initiator of the exact prompt turn. */
  requester: {
    senderId: string;
    senderName?: string;
    isOwner?: boolean;
  };
  /** Additive presentation metadata; never authoritative. */
  agent?: {
    name?: string;
    sessionAlias?: string;
  };
  message: string;
  mode: "form";
  fields: ChannelElicitationField[];
  expiresAt: number;
  /** Aborts on timeout, turn disposal, or shutdown. */
  signal: AbortSignal;
}

/**
 * Terminal decision. `responderId` MUST be the platform-authenticated
 * identity of whoever activated the control; core re-verifies it against
 * the exact turn initiator and never trusts self-reported payload ids.
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
   * backed by a real `requestElicitation` implementation are advertised.
   */
  readonly elicitationModes?: readonly ChannelElicitationMode[];

  /**
   * Render a form Elicitation for the authenticated turn initiator and
   * settle exactly once (first terminal decision wins). Implementations
   * MUST:
   *   - keep pending form state in server-side memory only;
   *   - never encode answer values into control ids or URLs;
   *   - return the platform-authenticated responder id;
   *   - settle within `expiresAt` / on `signal` abort by returning
   *     `{ action: "cancel", responderId }`.
   */
  requestElicitation?(
    request: ChannelElicitationRequest,
  ): Promise<ChannelElicitationDecision>;
}
