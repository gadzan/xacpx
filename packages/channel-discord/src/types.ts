/**
 * Protocol-side shapes for the Discord channel.
 */

export type DiscordReplyMode = "auto" | "streaming" | "static";
export type DiscordTableMode = "code" | "bullets" | "off";
export type DiscordChatKind = "dm" | "guild" | "thread";

export type DiscordDmPolicy = "open" | "allowlist" | "disabled";
export type DiscordGuildPolicy = "open" | "allowlist" | "disabled";

export interface DiscordRoute {
  accountId: string;
  kind: DiscordChatKind;
  channelId: string;
  guildId?: string;
}

export interface DiscordParsedRoute extends DiscordRoute {
  chatKey: string;
}

export interface DeliveryTarget {
  channelId: string;
  guildId?: string;
}

export interface DiscordInboundMessage {
  id: string;
  channelId: string;
  guildId?: string | null;
  author: { id: string; bot?: boolean };
  content: string;
  cleanContent?: string;
  createdTimestamp: number;
  mentions?: { users?: Array<{ id: string }>; everyone?: boolean; repliedUser?: { id: string } | null };
  senderRoleIds?: string[];
  attachments?: Array<{
    id: string;
    url: string;
    name?: string;
    contentType?: string | null;
    size?: number;
  }>;
  isThread?: boolean;
  parentChannelId?: string | null;
  referencedMessageId?: string | null;
  repliedUserId?: string | null;
  // Raw discord.js Message for mention checks when available
  raw?: unknown;
}
export interface OutboundBody {
  content?: string;
  files?: Array<{ attachment: Buffer | string; name?: string; description?: string }>;
  allowedMentions?: { parse?: string[]; users?: string[]; roles?: string[]; repliedUser?: boolean };
  components?: DiscordMessageComponents;
  /** Optional select rows. Discord rejects a select sharing a row with a button. */
  selectRows?: DiscordSelectActionRow[];
}

/**
 * Show a modal in response to this interaction.
 *
 * Discord only permits `showModal` inside an interaction response, so it hangs
 * off the interaction rather than the channel. The modal is shown to the user
 * who performed this interaction and to nobody else.
 */
export interface ShowModalInput {
  title: string;
  customId: string;
  components: DiscordModalLabel[];
}
export type DiscordMessageComponents = Array<DiscordActionRow>;
export interface DiscordActionRow {
  type: 1;
  components: DiscordButtonComponent[];
}
/**
 * A row holding a single String Select.
 *
 * Kept a separate type from `DiscordActionRow` rather than widening the
 * components array: a select row has exactly one child, and a union would let a
 * button and a select share a row, which Discord rejects.
 */
export interface DiscordSelectActionRow {
  type: 1;
  components: DiscordSelectComponent[];
}
export interface DiscordSelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}
export interface DiscordSelectComponent {
  type: 3;
  customId: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  options: DiscordSelectOption[];
  disabled?: boolean;
}
/**
 * A modal's Text Input. Its `custom_id` is POSITIONAL (`f:<index>`), never the
 * schema key — core allows a 128-char key and Discord caps component ids at 100.
 */
export interface DiscordTextInputComponent {
  type: 4;
  customId: string;
  style: 1 | 2;
  label: string;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
  value?: string;
  placeholder?: string;
}

/**
 * Modal labels each wrap exactly one Text Input (`APITextInputComponent`:
 * "Text inputs can only be used within modals"). Input count per modal is
 * bounded by `DISCORD_MODAL_INPUT_MAX` in elicitation-limits.ts.
 */
export interface DiscordModalLabel {
  label: string;
  component: DiscordTextInputComponent;
}
export interface DiscordButtonComponent {
  type: 2;
  style: 1 | 2 | 3 | 4;
  label: string;
  customId: string;
  disabled?: boolean;
}
export interface DiscordButtonInteraction {
  customId: string;
  userId: string;
  channelId: string;
  guildId?: string;
  acknowledge(): Promise<void>;
  replyEphemeral(text: string): Promise<void>;
  showModal(modal: ShowModalInput): Promise<void>;
}

/**
 * A String Select interaction (message component or modal field).
 *
 * `values` are the selected OPTION VALUES (what core receives as the answer),
 * never labels: an option's label is agent-controlled display text and may be
 * truncated or rewritten, while its value is the correlation identity the core
 * answer validator checks.
 */
export interface DiscordSelectInteraction {
  customId: string;
  userId: string;
  channelId: string;
  guildId?: string;
  values: string[];
  acknowledge(): Promise<void>;
  replyEphemeral(text: string): Promise<void>;
}

/**
 * A modal submit.
 *
 * `fields` maps each Text Input `custom_id` to what the user typed. Those ids are
 * POSITIONAL (`f:<index>`) rather than the schema key: core allows a 128-char
 * key and Discord caps component ids at 100. No answer travels in any id, so a
 * modal payload cannot leak a value into a component id.
 */
export interface DiscordModalSubmitInteraction {
  customId: string;
  userId: string;
  channelId: string;
  guildId?: string;
  fields: Record<string, string>;
  acknowledge(): Promise<void>;
  replyEphemeral(text: string): Promise<void>;
}
