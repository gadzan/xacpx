import { isMessageUnavailable, markIfUnavailableError } from "../message-unavailable.js";
import { resolveFeishuReceiveIdType, normalizeFeishuTarget } from "../send.js";
import { t } from "../i18n/index.js";
import type { PlanEntry, PromptUsage } from "xacpx/plugin-api";
import {
  CARD_BODY_MAX_CHARS,
  STREAMING_ELEMENT_ID,
  buildCard,
  buildCardMessageContent,
  formatElapsedMs,
  formatUsageSegment,
  truncateForCardBody,
  type CardState,
} from "./card-builder.js";
import { FlushController } from "./flush-controller.js";
import { ImageResolver, type ImageUploadClient } from "./image-resolver.js";
import { optimizeMarkdownStyle } from "./markdown-style.js";
import { splitReasoningText } from "./reasoning.js";
import { registerShutdownHook } from "./shutdown-hooks.js";
import { ToolUseStore } from "./tool-use-store.js";
import type { ToolUseEvent } from "./tool-use-types.js";

export interface StreamingCardClient {
  cardkit: {
    v1: {
      card: {
        // The SDK (pinned to ~1.60) wraps responses in `{ data: ... }`. If a
        // future minor changes this, breakage surfaces as a type error rather
        // than a silent runtime `undefined` from a tolerant `??` fallback.
        create(input: {
          data: { type: "card_json"; data: string };
        }): Promise<{ data?: { card_id?: string } }>;
        update(input: {
          path: { card_id: string };
          data: { card: { type: "card_json"; data: string }; sequence: number };
        }): Promise<unknown>;
      };
      cardElement?: {
        content(input: {
          path: { card_id: string; element_id: string };
          data: { content: string; sequence: number };
        }): Promise<unknown>;
      };
    };
  };
  im: {
    message: {
      reply(input: {
        path: { message_id: string };
        data: { msg_type: "interactive"; content: string };
      }): Promise<{ data?: { message_id?: string; chat_id?: string } }>;
      create(input: {
        params: { receive_id_type: "chat_id" | "open_id" | "user_id" };
        data: { receive_id: string; msg_type: "interactive"; content: string };
      }): Promise<{ data?: { message_id?: string; chat_id?: string } }>;
    };
    image?: {
      create(input: { data: { image_type: "message"; image: unknown } }): Promise<unknown>;
    };
  };
}

export interface StreamingCardSeedInput {
  to: string;
  replyToMessageId?: string;
}

export interface StreamingCardSeedResult {
  cardId: string;
  messageId: string;
}

export interface StreamingCardControllerOptions {
  client: StreamingCardClient;
  flushIntervalMs?: number;
  now?: () => number;
  /** Set false to skip the markdown image-URL → image_key resolver. */
  resolveImages?: boolean;
  /** Max ms to wait for in-flight image uploads at terminal states. */
  imageResolveTimeoutMs?: number;
  /** Override HTTP fetch (used by the image resolver). Defaults to global fetch. */
  fetchUrl?: (url: string, options?: { maxBytes?: number }) => Promise<Buffer>;
  /** Max bytes per uploaded image (forwarded to {@link ImageResolver}). */
  imageMaxBytes?: number;
  /** LRU cap for the image resolver's resolved/failed cache. */
  imageCacheCap?: number;
  /** Account scope for the message-unavailable cache. */
  accountId?: string;
  /**
   * Called once when card updates have failed N consecutive times (default 3).
   * Receives the latest text buffer so the channel can deliver the answer via
   * a non-card path (plain reply) without losing the user's response.
   * After firing, the controller still attempts further updates so a
   * recovering Feishu can resume the card — but the channel should treat the
   * answer as delivered out-of-band.
   */
  onCardDegraded?: (input: { buffer: string; consecutiveFailures: number }) => void;
  /** Default 3. */
  failureThreshold?: number;
  /** Max chars for the card body before truncation; default 28000. */
  cardBodyMaxChars?: number;
  /** Interval for live elapsed-footer refresh while the card is non-terminal. Default 1000ms. */
  liveFooterTickMs?: number;
  setTimer?: (cb: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 800;
const DEFAULT_IMAGE_RESOLVE_TIMEOUT_MS = 3000;
const DEFAULT_LIVE_FOOTER_TICK_MS = 1000;

const TERMINAL_STATES: ReadonlySet<CardState> = new Set(["complete", "aborted", "error"]);
function isTerminalState(state: CardState): boolean {
  return TERMINAL_STATES.has(state);
}

export class StreamingCardController {
  private readonly client: StreamingCardClient;
  private readonly flush: FlushController;
  private readonly now: () => number;
  private readonly imageResolver: ImageResolver | null;
  private readonly imageResolveTimeoutMs: number;
  private readonly accountId: string | undefined;
  private readonly cardBodyMaxChars: number | undefined;
  private cardId: string | null = null;
  private messageId: string | null = null;
  // Text state, split into two roles:
  //   streamedText  — accumulated from appendStream() calls during the turn.
  //                   Each call is one aggregator batch (a complete paragraph),
  //                   so calls are joined with "\n\n".
  //   appendedFinal — extra tail set by complete(finalText). Used when the
  //                   transport returns content after streaming ended (e.g. a
  //                   WeChat overflow summary + final answer that was dropped
  //                   from the live stream). Rendered below streamedText.
  // The display body is buildDisplayText().
  private streamedText = "";
  private appendedFinal = "";
  private sequence = 1;
  private state: CardState = "thinking";
  private lastPushedState: CardState | null = null;
  private lastPushedReasoning: string | undefined = undefined;
  private reasoningBuffer = "";
  private reasoningStartedAt = 0;
  private reasoningLastAt = 0;
  private lastFooterText: string | null = null;
  private readonly toolUseStore: ToolUseStore;
  private lastPushedToolRevision = -1;
  // Latest usage side-channel (replace, not accumulate — each update is the
  // current window/turn snapshot). Folded into the footer text key so a change
  // forces the full card.update path off the streaming fast-path.
  private lastUsage: PromptUsage | undefined = undefined;
  // Latest plan/todo list (ACP `plan` re-sends the WHOLE list → replace).
  private planEntries: PlanEntry[] = [];
  private lastPushedPlanKey = "";
  private terminated = false;
  private seededAtMs = 0;
  private degraded = false;
  private disposeShutdownHook: (() => void) | null = null;
  private terminalUpdateDelivered = false;
  private readonly liveFooterTickMs: number;
  private readonly setTimer: (cb: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private liveFooterTimer: unknown = null;
  private readonly onCardDegraded: StreamingCardControllerOptions["onCardDegraded"];

  constructor(options: StreamingCardControllerOptions) {
    this.client = options.client;
    this.onCardDegraded = options.onCardDegraded;
    this.flush = new FlushController({
      minIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      ...(options.failureThreshold !== undefined ? { failureThreshold: options.failureThreshold } : {}),
      onFailureThreshold: (n) => {
        if (this.degraded) return;
        this.degraded = true;
        this.onCardDegraded?.({ buffer: this.buildDisplayText(), consecutiveFailures: n });
      },
    });
    this.now = options.now ?? (() => Date.now());
    this.toolUseStore = new ToolUseStore(this.now);
    this.imageResolveTimeoutMs = options.imageResolveTimeoutMs ?? DEFAULT_IMAGE_RESOLVE_TIMEOUT_MS;
    this.accountId = options.accountId;
    this.cardBodyMaxChars = options.cardBodyMaxChars;
    this.liveFooterTickMs = options.liveFooterTickMs ?? DEFAULT_LIVE_FOOTER_TICK_MS;
    this.setTimer = options.setTimer ?? ((cb, delay) => {
      const timer = setTimeout(cb, delay);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.imageResolver = options.resolveImages === false
      ? null
      : new ImageResolver({
          client: this.client as ImageUploadClient,
          onImageResolved: () => {
            if (this.terminated) return;
            this.flush.requestFlush(() => this.pushUpdate());
          },
          ...(options.fetchUrl ? { fetchUrl: options.fetchUrl } : {}),
          ...(options.imageMaxBytes !== undefined ? { maxBytes: options.imageMaxBytes } : {}),
          ...(options.imageCacheCap !== undefined ? { cacheCap: options.imageCacheCap } : {}),
        });
  }

  isTerminated(): boolean {
    return this.terminated;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  async seed(input: StreamingCardSeedInput): Promise<StreamingCardSeedResult> {
    this.seededAtMs = this.now();
    const initial = buildCard({
      state: "thinking",
      text: "",
      ...(this.cardBodyMaxChars !== undefined ? { maxBodyChars: this.cardBodyMaxChars } : {}),
    });
    const createResp = await this.client.cardkit.v1.card.create({
      data: { type: "card_json", data: JSON.stringify(initial) },
    });
    const cardId = createResp.data?.card_id;
    if (!cardId) {
      throw new Error("Feishu card.create returned no card_id");
    }
    this.cardId = cardId;
    const content = buildCardMessageContent(cardId);

    const replyTo = input.replyToMessageId && !isMessageUnavailable(input.replyToMessageId, this.accountId) ? input.replyToMessageId : undefined;
    let messageId: string | undefined;
    if (replyTo) {
      try {
        const r = await this.client.im.message.reply({
          path: { message_id: replyTo },
          data: { msg_type: "interactive", content },
        });
        messageId = r.data?.message_id;
      } catch (error) {
        markIfUnavailableError(replyTo, error, this.accountId);
        // fall through to fresh send
      }
    }
    if (!messageId) {
      const target = normalizeFeishuTarget(input.to);
      const r = await this.client.im.message.create({
        params: { receive_id_type: resolveFeishuReceiveIdType(target) },
        data: { receive_id: target, msg_type: "interactive", content },
      });
      messageId = r.data?.message_id;
    }
    if (!messageId) {
      throw new Error("Feishu interactive message send returned no message_id");
    }
    this.messageId = messageId;
    this.disposeShutdownHook = registerShutdownHook(`feishu-card:${cardId}`, async () => {
      if (this.terminalUpdateDelivered) return;
      try {
        await this.abortForShutdown();
      } catch {
        // swallow — process is going down
      }
    });
    this.scheduleLiveFooterTick();
    return { cardId, messageId };
  }

  appendStream(chunk: string): void {
    if (!this.transitionTo("streaming") || !this.cardId) return;
    // Each appendStream call is one complete aggregator batch (a paragraph),
    // not a partial token. Insert a paragraph break between calls so markdown
    // renders them as distinct blocks instead of squashing tool-call lines and
    // agent text into one wall. Skip when prior content already ends with a
    // blank line so we don't double-space when chunks already carry trailing
    // newlines.
    if (this.streamedText.length > 0 && !this.streamedText.endsWith("\n\n")) {
      this.streamedText += this.streamedText.endsWith("\n") ? "\n" : "\n\n";
    }
    this.streamedText += chunk;
    this.flush.requestFlush(() => this.pushUpdate());
  }

  recordToolEvent(event: ToolUseEvent): void {
    if (this.terminated) return;
    this.toolUseStore.record(event);
    if (!this.cardId) return;
    // Ensure the next push goes through the full card.update path so the
    // tool-use panel actually renders (the fast-path only touches the
    // streaming_content element).
    this.flush.requestFlush(() => this.pushUpdate());
  }

  recordUsage(usage: PromptUsage): void {
    if (this.terminated) return;
    this.lastUsage = usage;
    if (!this.cardId) return;
    // Usage lives in the footer, not streaming_content — pushUpdate detects the
    // footer-text change and takes the full card.update path.
    this.flush.requestFlush(() => this.pushUpdate());
  }

  recordPlan(entries: PlanEntry[]): void {
    if (this.terminated) return;
    // Replace, don't append — the agent re-sends the whole list each update.
    this.planEntries = entries;
    if (!this.cardId) return;
    // Plan renders as a separate collapsible panel, so it can't ride the
    // streaming_content fast-path — pushUpdate detects the change and takes
    // the full card.update path.
    this.flush.requestFlush(() => this.pushUpdate());
  }

  appendReasoning(chunk: string): void {
    if (this.terminated) return;
    const t = this.now();
    if (this.reasoningStartedAt === 0) this.reasoningStartedAt = t;
    this.reasoningLastAt = t;
    this.reasoningBuffer += chunk;
    if (!this.cardId) return;
    // Reasoning lives in a separate (collapsible) element, so it can't ride
    // the streaming_content fast-path — pushUpdate detects the content change
    // and takes the full card.update path.
    this.flush.requestFlush(() => this.pushUpdate());
  }

  async complete(finalText?: string): Promise<void> {
    if (!this.transitionTo("complete")) return;
    // Treat finalText as a *tail* appended below the streamed content, not a
    // replacement. In streaming mode the transport normally returns "" (every
    // segment was already pushed via reply()); replacing the buffer with that
    // empty string would wipe the entire live progress, leaving the user with
    // only a "已完成" footer. The non-empty case is the overflow scenario
    // where the transport returns "summary + dropped final answer" — also a
    // tail, not a replacement.
    if (typeof finalText === "string" && finalText.length > 0) {
      this.appendedFinal = finalText;
    }
    // Drain any in-flight streaming flushes first so they get a chance to kick
    // off image uploads we need to wait for.
    await this.flush.waitIdle();
    await this.awaitImageUploads();
    // Re-drain: awaiting uploads can trigger more flushes via onImageResolved.
    await this.flush.waitIdle();
    this.terminated = true;
    await this.flush.forceFlush(() => this.pushUpdate());
    this.markTerminalUpdateDelivered();
  }

  async abort(message?: string): Promise<void> {
    if (!this.transitionTo("aborted")) return;
    // Same rationale as complete(): the streamed text is what the user was
    // watching — don't wipe it. The "已停止" status appears in the summary
    // and footer; the abort message is only used as a fallback display when
    // there's nothing streamed yet.
    if (typeof message === "string" && message.length > 0 && this.streamedText.length === 0) {
      this.streamedText = message;
    }
    // No image wait for abort — we want to render the stopped state promptly.
    this.terminated = true;
    await this.flush.forceFlush(() => this.pushUpdate());
    this.markTerminalUpdateDelivered();
  }

  private async abortForShutdown(): Promise<void> {
    if (this.terminalUpdateDelivered) return;
    if (!isTerminalState(this.state)) {
      await this.abort();
      return;
    }
    // State is already terminal (complete/error/aborted) but the update hasn't
    // been delivered. Don't overwrite the terminal — just flush whatever's
    // there. The user should see the actual final state, not a shutdown-forced
    // "aborted" overlay on top of a successful complete.
    this.clearLiveFooterTick();
    this.terminated = true;
    await this.flush.forceFlush(() => this.pushUpdate());
    this.markTerminalUpdateDelivered();
  }

  async fail(errorMessage: string): Promise<void> {
    if (!this.transitionTo("error")) return;
    // Preserve whatever the agent had already streamed; append the error
    // message as a footnote so partial output isn't lost.
    const tail = errorMessage.trim();
    if (tail) {
      this.streamedText = this.streamedText.length > 0
        ? `${this.streamedText.trimEnd()}\n\n${t().errorFootnote(tail)}`
        : tail;
    }
    this.terminated = true;
    await this.flush.forceFlush(() => this.pushUpdate());
    this.markTerminalUpdateDelivered();
  }

  /**
   * Compose the card body from the two-state text model. streamedText holds
   * everything pushed during the turn; appendedFinal is the optional tail from
   * complete(). When both are present we join with a blank line so the final
   * tail visually separates from the progress.
   */
  private buildDisplayText(): string {
    if (this.appendedFinal && this.streamedText) {
      return `${this.streamedText}\n\n${this.appendedFinal}`;
    }
    return this.appendedFinal || this.streamedText;
  }

  /**
   * Atomically advance the state machine. Returns false (no-op) when the
   * transition isn't legal — protects against complete/abort/fail racing each
   * other, and prevents stray appendStream calls from resurrecting a closed
   * card. Sets terminal state synchronously so concurrent callers can't both
   * pass through; the actual `terminated` flag flips after async work.
   */
  private transitionTo(next: CardState): boolean {
    if (this.state === next) {
      // Idempotent for "streaming" (each chunk re-asserts it). Terminal states
      // get rejected to keep the first complete/abort/fail authoritative.
      if (next === "streaming") return true;
      return false;
    }
    if (isTerminalState(this.state)) return false;
    if (next === "streaming" && this.state !== "thinking") return false;
    this.state = next;
    if (isTerminalState(this.state)) this.clearLiveFooterTick();
    return true;
  }

  private markTerminalUpdateDelivered(): void {
    this.terminalUpdateDelivered = true;
    this.disposeShutdownHook?.();
    this.disposeShutdownHook = null;
    this.clearLiveFooterTick();
  }

  private scheduleLiveFooterTick(): void {
    if (this.liveFooterTickMs <= 0 || this.liveFooterTimer !== null || this.terminated || isTerminalState(this.state)) {
      return;
    }
    this.liveFooterTimer = this.setTimer(() => {
      this.liveFooterTimer = null;
      if (this.terminated || isTerminalState(this.state)) return;
      if (!this.cardId) return;
      this.flush.requestFlush(() => this.pushUpdate());
      this.scheduleLiveFooterTick();
    }, this.liveFooterTickMs);
  }

  private clearLiveFooterTick(): void {
    if (this.liveFooterTimer === null) return;
    this.clearTimer(this.liveFooterTimer);
    this.liveFooterTimer = null;
  }

  private async awaitImageUploads(): Promise<void> {
    if (!this.imageResolver || !this.imageResolver.hasPending()) return;
    await this.imageResolver.resolveImagesAwait(this.buildDisplayText(), this.imageResolveTimeoutMs);
  }

  async waitIdle(): Promise<void> {
    await this.flush.waitIdle();
  }

  private async pushUpdate(): Promise<void> {
    if (!this.cardId || !this.messageId) return;
    if (isMessageUnavailable(this.messageId, this.accountId)) return;
    const displayText = this.buildDisplayText();
    const resolvedBuffer = this.imageResolver ? this.imageResolver.resolveImages(displayText) : displayText;
    const split = splitReasoningText(resolvedBuffer);
    const answerSource = split.answerText ?? (split.reasoningText ? "" : resolvedBuffer);
    const renderedRaw = this.state === "thinking" ? answerSource : optimizeMarkdownStyle(answerSource);
    // Cap before either delivery path: buildCard re-caps to be safe, but the
    // element-content fast-path bypasses buildCard so it has to be capped
    // here too — otherwise long output sneaks past the body limit and
    // triggers CardKit "content too large" errors that count as flush
    // failures and eventually degrade the card.
    const cardBodyMax = this.cardBodyMaxChars ?? CARD_BODY_MAX_CHARS;
    const rendered = truncateForCardBody(renderedRaw, cardBodyMax);
    // Reasoning sources, in priority order: the onThought side-channel buffer
    // (acpx agent_thought_chunk) wins; fall back to <think>-tag parsing of the
    // answer text for agents that embed reasoning inline.
    const accumulatedReasoning = this.reasoningBuffer.trim();
    const reasoningSource = accumulatedReasoning || split.reasoningText;
    const reasoningRendered = reasoningSource
      ? optimizeMarkdownStyle(reasoningSource).trim() || undefined
      : undefined;
    // Elapsed applies only to the timed onThought source.
    const reasoningElapsedMs =
      accumulatedReasoning && this.reasoningStartedAt > 0
        ? this.reasoningLastAt - this.reasoningStartedAt
        : undefined;
    // Compare rendered reasoning content (not just presence) so a streaming
    // thought update forces the full card.update path — the element-content
    // fast-path only touches streaming_content and would never refresh the
    // collapsed reasoning panel.
    const reasoningChanged = reasoningRendered !== this.lastPushedReasoning;

    const elapsedMs = this.seededAtMs > 0 ? this.now() - this.seededAtMs : undefined;
    const usageText = this.lastUsage ? formatUsageSegment(this.lastUsage) : "";
    const currentFooterText = computeFooterText(this.state, elapsedMs, usageText);
    const footerChanged = currentFooterText !== this.lastFooterText;

    const toolSteps = this.toolUseStore.steps();
    const toolRevision = this.toolUseStore.getRevision();
    const toolStepsChanged = toolRevision !== this.lastPushedToolRevision;

    const planKey = this.planEntries.length > 0 ? planStateKey(this.planEntries) : "";
    const planChanged = planKey !== this.lastPushedPlanKey;

    const elementApi = this.client.cardkit.v1.cardElement;
    if (
      this.state === "streaming" &&
      this.lastPushedState === "streaming" &&
      !reasoningChanged &&
      !footerChanged &&
      !toolStepsChanged &&
      !planChanged &&
      elementApi
    ) {
      const seq = this.sequence++;
      try {
        await elementApi.content({
          path: { card_id: this.cardId, element_id: STREAMING_ELEMENT_ID },
          data: { content: rendered, sequence: seq },
        });
        return;
      } catch (error) {
        markIfUnavailableError(this.messageId, error, this.accountId);
        // fall through to a full card update — safer fallback for any
        // element-level failure (missing scope, element gone, etc.)
      }
    }

    const card = buildCard({
      state: this.state,
      text: rendered,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(reasoningRendered ? { reasoningText: reasoningRendered } : {}),
      ...(reasoningElapsedMs !== undefined ? { reasoningElapsedMs } : {}),
      ...(toolSteps.length > 0 ? { toolSteps } : {}),
      ...(this.planEntries.length > 0 ? { planEntries: this.planEntries } : {}),
      ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      ...(this.cardBodyMaxChars !== undefined ? { maxBodyChars: this.cardBodyMaxChars } : {}),
    });
    const seq = this.sequence++;
    try {
      await this.client.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: { card: { type: "card_json", data: JSON.stringify(card) }, sequence: seq },
      });
      this.lastPushedState = this.state;
      this.lastPushedReasoning = reasoningRendered;
      this.lastFooterText = currentFooterText;
      this.lastPushedToolRevision = toolRevision;
      this.lastPushedPlanKey = planKey;
    } catch (error) {
      // 230011/231003 mean the message is gone — that's a terminal "success"
      // for our purposes; don't count it as a failure (the user couldn't see
      // updates anyway). Other errors get surfaced so FlushController can
      // track the streak and potentially trigger onCardDegraded.
      const recognizedTerminal = markIfUnavailableError(this.messageId, error, this.accountId);
      if (recognizedTerminal) return;
      throw error;
    }
  }
}

function computeFooterText(state: CardState, elapsedMs: number | undefined, usageText: string): string {
  if (elapsedMs === undefined && !usageText) return state;
  return `${state}|${elapsedMs === undefined ? "" : formatElapsedMs(elapsedMs)}|${usageText}`;
}

function planStateKey(entries: PlanEntry[]): string {
  return entries.map((entry) => `${entry.status}:${entry.content}`).join("\n");
}
