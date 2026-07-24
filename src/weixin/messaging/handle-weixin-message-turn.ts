import crypto from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Agent, ChatRequest } from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import {
  RuntimeMediaStore,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../channels/media-store.js";
import { resolveSafeOutboundMediaPath as resolveSafeMediaPath } from "../../channels/outbound-media-safety.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { getExtensionFromMime } from "../media/mime.js";

import { buildBackgroundCompletionNotice, shouldSendBackgroundNotice } from "./completion-notice.js";
import { executeChatTurn } from "./execute-chat-turn.js";
import { buildFinalHeadsUp } from "./final-heads-up.js";
import { shouldDeliverSegment, resolveFinalDisposition } from "./foreground-gate.js";
import { setContextToken, bodyFromItemList, extractWeixinMediaDescriptors } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "./send.js";
import type { PendingFinalChunk } from "./quota-manager.js";
import { handleSlashCommand } from "./slash-commands.js";
import { normalizeMediaArray } from "../../channels/media-types.js";
import { SubagentNoticeTracker } from "../../channels/subagent-notice.js";
import { createNoopPerfTracer, type PerfTracer } from "../../perf/perf-tracer.js";
import { t } from "../../i18n/index.js";

// Conservative WeChat single-message text upper bound; leaves headroom for
// `(i/N) ` prefixes and the heads-up tail. WeChat's actual limit varies by
// client/version; 1800 bytes (~600 CJK characters) is well within all
// observed thresholds.
const MAX_FINAL_CHUNK_BYTES = 1800;

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// Splits a long final-text payload into <= maxBytes UTF-8 chunks. Tries
// paragraph (\n\n) → line (\n) → codepoint boundary in that order so the
// reading flow stays intact whenever the structure allows it. Each returned
// chunk is the raw payload — the (i/N) pagination prefix is added by the
// sender, not here.
export function chunkFinalText(text: string, maxBytes: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (utf8ByteLength(trimmed) <= maxBytes) return [trimmed];

  // Split into paragraph-units, each unit may itself need further splitting.
  const paragraphUnits: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    if (para.length === 0) continue;
    if (utf8ByteLength(para) <= maxBytes) {
      paragraphUnits.push(para);
      continue;
    }
    // Paragraph too large: split by line.
    const lineUnits: string[] = [];
    let lineBuf = "";
    for (const line of para.split("\n")) {
      if (utf8ByteLength(line) > maxBytes) {
        if (lineBuf.length > 0) {
          lineUnits.push(lineBuf);
          lineBuf = "";
        }
        // Hard-cut by codepoint.
        for (const piece of hardCutByCodepoint(line, maxBytes)) {
          lineUnits.push(piece);
        }
        continue;
      }
      const candidate = lineBuf.length === 0 ? line : `${lineBuf}\n${line}`;
      if (utf8ByteLength(candidate) > maxBytes) {
        if (lineBuf.length > 0) lineUnits.push(lineBuf);
        lineBuf = line;
      } else {
        lineBuf = candidate;
      }
    }
    if (lineBuf.length > 0) lineUnits.push(lineBuf);
    for (const lu of lineUnits) paragraphUnits.push(lu);
  }

  // Greedily combine paragraph units into chunks ≤ maxBytes.
  const chunks: string[] = [];
  let buf = "";
  for (const unit of paragraphUnits) {
    if (buf.length === 0) {
      buf = unit;
      continue;
    }
    const candidate = `${buf}\n\n${unit}`;
    if (utf8ByteLength(candidate) > maxBytes) {
      chunks.push(buf);
      buf = unit;
    } else {
      buf = candidate;
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

function hardCutByCodepoint(s: string, maxBytes: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const cp of s) {
    const candidate = buf + cp;
    if (utf8ByteLength(candidate) > maxBytes) {
      if (buf.length > 0) {
        out.push(buf);
        buf = cp;
      } else {
        // Single codepoint exceeds maxBytes (unlikely; max codepoint = 4
        // bytes). Emit it anyway to avoid an infinite loop.
        out.push(cp);
        buf = "";
      }
    } else {
      buf = candidate;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

export function resolveMediaTempDir(customRoot?: string): string {
  return customRoot ?? path.join(tmpdir(), "xacpx", "media");
}


function createSaveMediaBuffer(mediaTempDir?: string) {
  return async function saveMediaBuffer(
    buffer: Buffer,
    contentType?: string,
    subdir?: string,
    maxBytes?: number,
    originalFilename?: string,
  ): Promise<{ path: string }> {
    if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
      throw new Error(`media exceeds ${maxBytes} bytes`);
    }
    const dir = path.join(resolveMediaTempDir(mediaTempDir), subdir ?? "");
    await fs.mkdir(dir, { recursive: true });
    let ext = ".bin";
    if (originalFilename) {
      ext = path.extname(originalFilename) || ".bin";
    } else if (contentType) {
      ext = getExtensionFromMime(contentType);
    }
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, buffer);
    return { path: filePath };
  };
}

export type HandleWeixinMessageTurnDeps = {
  accountId: string;
  agent: Agent;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  mediaTempDir?: string;
  onInbound?: (chatKey: string) => void;
  // v1.3: reserveFinal returns false when the per-chat final tier is
  // exhausted (FINAL_BUDGET reached). Callers MUST drop the send and log
  // when this happens; otherwise the WeChat send will be wasted past the
  // 10-message hard cap.
  reserveFinal?: (chatKey: string) => boolean;
  // v1.4: how many final-tier slots remain in the current inbound window.
  // Used to size the first wave of paginated final answers; the remainder is
  // parked via enqueuePendingFinal until the user replies `/jx`.
  finalRemaining?: (chatKey: string) => number;
  // v1.4: park leftover final chunks so the next `/jx` can drain the next
  // wave. Caller (run-console / monitor) wires this to QuotaManager.
  enqueuePendingFinal?: (chatKey: string, chunks: PendingFinalChunk[]) => void;
  // v1.4: pending-final inspection / drain accessors, plumbed into the slash
  // command context so `/jx` can pull the next wave.
  hasPendingFinal?: (chatKey: string) => boolean;
  drainPendingFinal?: (chatKey: string, available: number) => PendingFinalChunk[];
  prependPendingFinal?: (chatKey: string, chunks: PendingFinalChunk[]) => void;
  mediaStore?: RuntimeMediaStore;
  downloadMediaFromItemFn?: typeof downloadMediaFromItem;
  allowedMediaRoots?: string[];
  perfTracer?: PerfTracer;
  // When provided, returns true iff this turn's bound session is still the
  // chat's live foreground session. Omitted = always foreground (legacy).
  isForeground?: () => boolean;
  // Internal alias of the session this turn is bound to (for bg-result keying).
  boundSessionAlias?: string;
  // Called when this turn finishes while BACKGROUND, to store the final result
  // for later replay. text is the final answer (or error message).
  onBackgroundFinal?: (alias: string, text: string, status: "done" | "error") => Promise<void>;
};

function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

function isClearSlashCommand(textBody: string): boolean {
  const trimmed = textBody.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  return command === "/clear";
}

function isSlashCommandText(textBody: string): boolean {
  return textBody.startsWith("/");
}

export function getWeixinMessageTurnLane(full: WeixinMessage): "normal" | "control" {
  const textBody = extractTextBody(full.item_list).trim().toLowerCase();
  const command = textBody.split(/\s+/)[0] ?? "";
  // Switch commands must preempt an in-flight prompt so the user can change the
  // foreground session in real time; they only touch chat-context state and
  // never run a long task, so the control lane is safe. /jx is the quota-refill
  // ack no-op (see onInbound). /cancel and /stop interrupt the current turn.
  const isSwitch = command === "/use" || command === "/ss";
  return command === "/cancel" || command === "/stop" || command === "/jx" || isSwitch
    ? "control"
    : "normal";
}

export function buildWeixinChatKey(accountId: string, userId: string): string {
  return `weixin:${accountId}:${userId}`;
}

function defaultWeixinMime(kind: "image" | "file" | "audio" | "video"): string {
  if (kind === "image") return "image/*";
  if (kind === "video") return "video/mp4";
  if (kind === "audio") return "audio/wav";
  return "application/octet-stream";
}

function appendAttachmentNotes(text: string, notes: string[]): string {
  if (notes.length === 0) return text;
  return [text, "", "Attachment notes:", ...notes.map((note) => `- ${note}`)].filter(Boolean).join("\n");
}

export async function handleWeixinMessageTurn(
  full: WeixinMessage,
  deps: HandleWeixinMessageTurnDeps,
): Promise<void> {
  const receivedAt = Date.now();
  const textBody = extractTextBody(full.item_list);
  const fromUserId = full.from_user_id ?? "";
  const to = full.from_user_id ?? "";
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let typingStarted = false;
  const startTypingIndicator = () => {
    if (!deps.typingTicket || typingStarted) return;
    typingStarted = true;
    const sendTypingOnce = () => {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        body: {
          ilink_user_id: to,
          typing_ticket: deps.typingTicket,
          status: TypingStatus.TYPING,
        },
      }).catch(() => {});
    };
    sendTypingOnce();
    typingTimer = setInterval(sendTypingOnce, 10_000);
  };
  const stopTypingIndicator = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    if (!typingStarted || !deps.typingTicket) return;
    typingStarted = false;
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status: TypingStatus.CANCEL,
      },
    }).catch(() => {});
  };
  // Note: onInbound is fired by the SDK monitor before lane queueing so a user
  // reply during a long-running prompt resets the quota window immediately
  // rather than waiting for this turn to drain off the lane. The deps field
  // remains for direct unit testability of this function.

  const chatKey = buildWeixinChatKey(deps.accountId, fromUserId);
  const initialMediaCount = extractWeixinMediaDescriptors(full.item_list).length;
  const isSlashCommand = isSlashCommandText(textBody);
  const tracer = deps.perfTracer ?? createNoopPerfTracer();
  return await tracer.wrapTurn(
    { chatKey, kind: isSlashCommand ? "command" : "prompt" },
    async (perfSpan) => {
      perfSpan.mark("turn.received", {
        textLen: textBody.length,
        hasMedia: initialMediaCount > 0,
        mediaCount: initialMediaCount,
      });

  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }

  if (isSlashCommand) {
    const shouldTypeForSlash = isClearSlashCommand(textBody);
    if (shouldTypeForSlash) {
      startTypingIndicator();
    }
    try {
      const slashResult = await handleSlashCommand(
        textBody,
        {
          to,
          contextToken: full.context_token,
          baseUrl: deps.baseUrl,
          token: deps.token,
          accountId: deps.accountId,
          log: deps.log,
          errLog: deps.errLog,
          onClear: () => deps.agent.clearSession?.(chatKey),
          ...(deps.hasPendingFinal ? { hasPendingFinal: deps.hasPendingFinal } : {}),
          ...(deps.drainPendingFinal ? { drainPendingFinal: deps.drainPendingFinal } : {}),
          ...(deps.prependPendingFinal ? { prependPendingFinal: deps.prependPendingFinal } : {}),
          ...(deps.reserveFinal ? { reserveFinal: deps.reserveFinal } : {}),
          ...(deps.finalRemaining ? { finalRemaining: deps.finalRemaining } : {}),
        },
        receivedAt,
        full.create_time_ms,
      );
      if (slashResult.handled) return;
    } finally {
      if (shouldTypeForSlash) {
        stopTypingIndicator();
      }
    }
  }

  startTypingIndicator();

  const mediaStore = deps.mediaStore ?? new RuntimeMediaStore({ rootDir: resolveMediaTempDir(deps.mediaTempDir) });
  const media: NonNullable<ChatRequest["media"]> = [];
  const attachmentNotes: string[] = [];
  const descriptors = extractWeixinMediaDescriptors(full.item_list).slice(0, DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE);
  const download = deps.downloadMediaFromItemFn ?? downloadMediaFromItem;
  for (const descriptor of descriptors) {
    try {
      const downloaded = await download(descriptor.item, {
        cdnBaseUrl: deps.cdnBaseUrl,
        saveMedia: createSaveMediaBuffer(deps.mediaTempDir),
        log: deps.log,
        errLog: deps.errLog,
        label: "inbound",
      });
      const filePath = downloaded.decryptedPicPath ?? downloaded.decryptedVideoPath ?? downloaded.decryptedFilePath ?? downloaded.decryptedVoicePath;
      if (!filePath) {
        attachmentNotes.push(`Skipped ${descriptor.kind}: media was unavailable.`);
        continue;
      }
      try {
        const buffer = await fs.readFile(filePath);
        const mimeType = downloaded.fileMediaType ?? downloaded.voiceMediaType ?? defaultWeixinMime(descriptor.kind);
        media.push(await mediaStore.saveMediaBuffer({
          channelId: "weixin",
          accountId: deps.accountId,
          chatKey: buildWeixinChatKey(deps.accountId, full.from_user_id ?? ""),
          messageId: full.message_id ? String(full.message_id) : full.context_token ?? String(full.create_time_ms ?? Date.now()),
          fileName: descriptor.fileName,
          mimeType,
          kind: descriptor.kind,
          buffer,
          maxBytes: descriptor.kind === "image" ? DEFAULT_IMAGE_MAX_BYTES : DEFAULT_ATTACHMENT_MAX_BYTES,
        }));
      } finally {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
    } catch (err) {
      deps.errLog(`media download failed: ${String(err)}`);
      attachmentNotes.push(`Skipped ${descriptor.kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let midFirstSent = false;
  const sendReplySegment = async (text: string): Promise<boolean> => {
    if (!shouldDeliverSegment(deps.isForeground)) {
      return false;
    }
    const plainText = markdownToPlainText(text).trim();
    if (plainText.length === 0) {
      return false;
    }

    try {
      await sendMessageWeixin({
        to,
        text: plainText,
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
      });
      if (!midFirstSent) {
        midFirstSent = true;
        perfSpan.mark("reply.mid_first_sent", { bytes: utf8ByteLength(plainText) });
      }
      return true;
    } catch (err) {
      deps.errLog(`intermediate reply failed: ${String(err)}`);
      return false;
    }
  };

  const requestText = appendAttachmentNotes(bodyFromItemList(full.item_list), attachmentNotes);
  // Text-only degradation: WeChat can't render the subagent card, so a
  // delegation surfaces as one honest line via the existing reply path.
  // Ordinary tool calls stay hidden; the tracker dedups per toolCallId.
  const subagentNotices = new SubagentNoticeTracker();
  const request: Omit<ChatRequest, "reply"> = {
    accountId: deps.accountId,
    conversationId: buildWeixinChatKey(deps.accountId, full.from_user_id ?? ""),
    text: requestText,
    ...(media.length > 0 ? { media } : {}),
    replyContextToken: contextToken,
    // The in-session coordinator agent's scheduled_create/list/cancel tools and
    // group-owner command authorization both require chatType on the recorded
    // chat route. Built-in WeChat is direct unless the message carries group_id.
    metadata: {
      channel: "weixin",
      chatType: full.group_id ? "group" : "direct",
      ...(full.from_user_id ? { senderId: full.from_user_id } : {}),
      ...(full.group_id ? { groupId: full.group_id } : {}),
      // Carry the dispatch-time bound session alias so handlePrompt runs the
      // queued prompt against the session that was current when the user sent
      // it, instead of re-reading current_session (which may have changed while
      // the prompt waited on the per-session lane).
      ...(deps.boundSessionAlias ? { boundSessionAlias: deps.boundSessionAlias } : {}),
    },
    onToolEvent: (event) => {
      const line = subagentNotices.notice(event);
      if (line) void sendReplySegment(line);
    },
    perfSpan,
  };

  try {
    const turn = await executeChatTurn({
      agent: deps.agent,
      request,
      onReplySegment: sendReplySegment,
    });

    // Text is sent first, then media items in sequence.
    const outboundMedia = normalizeMediaArray(turn.media);
    let finalFirstSent = false;
    let finalChunksSent = 0;
    let finalChunksPending = 0;
    let finalDropped = false;
    if (turn.text) {
      const finalText = markdownToPlainText(turn.text).trim();
      if (finalText.length > 0) {
        const disposition = resolveFinalDisposition(
          shouldDeliverSegment(deps.isForeground),
          Boolean(deps.boundSessionAlias && deps.onBackgroundFinal),
        );
        if (disposition === "store") {
          await deps.onBackgroundFinal!(deps.boundSessionAlias!, finalText, "done");
          if (shouldSendBackgroundNotice(deps.reserveFinal ? () => deps.reserveFinal!(to) : undefined)) {
            await sendMessageWeixin({
              to,
              text: buildBackgroundCompletionNotice(deps.boundSessionAlias!, "done"),
              opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
            }).catch((e) => deps.errLog(`bg completion notice failed: ${String(e)}`));
          } else {
            deps.errLog(`weixin.final.dropped reason=quota_exhausted kind=bg_notice chatKey=${to}`);
          }
        } else if (disposition === "drop") {
          deps.errLog(`weixin.final.dropped reason=backgrounded_no_store kind=text chatKey=${to}`);
        } else {
          const rawChunks = chunkFinalText(finalText, MAX_FINAL_CHUNK_BYTES);
          // v1.5: when the final quota is exhausted and the whole answer ends
          // up parked (zero pages sent), tell the user once that /jx drains
          // it. The notice is a fixed-size system message, not model output,
          // so it deliberately bypasses the final-quota counter — with the
          // quota at zero it would be unsendable by construction otherwise.
          const sendAllParkedNotice = async (count: number): Promise<void> => {
            try {
              await sendMessageWeixin({
                to,
                text: t().misc.finalAllParked(count),
                opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
              });
            } catch (noticeErr) {
              deps.errLog(`weixin.final.parked_notice_failed chatKey=${to} err=${String(noticeErr)}`);
            }
          };
          const buildPendingChunk = (text: string, seq: number, total: number): PendingFinalChunk => {
            const entry: PendingFinalChunk = { text, seq, total };
            if (contextToken !== undefined) entry.contextToken = contextToken;
            if (deps.accountId !== undefined) entry.accountId = deps.accountId;
            return entry;
          };
          if (rawChunks.length > 0) {
            const total = rawChunks.length;
            if (total === 1) {
              const reserved = deps.reserveFinal ? deps.reserveFinal(to) : true;
              if (!reserved) {
                if (deps.enqueuePendingFinal) {
                  // Park the answer instead of dropping it; /jx drains it on
                  // the next inbound window.
                  deps.enqueuePendingFinal(to, [buildPendingChunk(rawChunks[0]!, 1, 1)]);
                  finalChunksPending = 1;
                  deps.errLog(
                    `weixin.final.parked reason=quota_exhausted kind=text chatKey=${to}`,
                  );
                  await sendAllParkedNotice(1);
                } else {
                  finalDropped = true;
                  deps.errLog(
                    `weixin.final.dropped reason=quota_exhausted kind=text chatKey=${to}`,
                  );
                }
              } else {
                await sendMessageWeixin({
                  to,
                  text: rawChunks[0]!,
                  opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
                });
                finalChunksSent += 1;
                if (!finalFirstSent) {
                  finalFirstSent = true;
                  perfSpan.mark("reply.final_first_sent", { bytes: utf8ByteLength(rawChunks[0]!), chunkIndex: 1 });
                }
              }
            } else {
              // v1.4: pre-format every chunk with its (k/N) prefix, send the first
              // wave (up to finalRemaining slots), park the rest in pending. If the
              // wave does not finish the answer, append a heads-up tail to the
              // wave's last chunk so the user knows to reply `/jx`.
              const prefixed = rawChunks.map((body, i) => `(${i + 1}/${total}) ${body}`);
              const available = deps.finalRemaining ? deps.finalRemaining(to) : total;
              const waveSize = Math.max(Math.min(available, total), 0);
              const wave = prefixed.slice(0, waveSize);
              const rest = prefixed.slice(waveSize);
              if (wave.length > 0 && rest.length > 0) {
                const sentSoFar = wave.length;
                wave[wave.length - 1] = `${wave[wave.length - 1]!}\n\n${buildFinalHeadsUp({
                  total,
                  sentSoFar,
                })}`;
              }
              let sent = 0;
              for (let i = 0; i < wave.length; i += 1) {
                const reserved = deps.reserveFinal ? deps.reserveFinal(to) : true;
                if (!reserved) {
                  finalDropped = true;
                  deps.errLog(
                    `weixin.final.dropped reason=quota_exhausted kind=text_paginated chatKey=${to} chunk=${i + 1}/${total}`,
                  );
                  break;
                }
                try {
                  await sendMessageWeixin({
                    to,
                    text: wave[i]!,
                    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
                  });
                  sent += 1;
                  finalChunksSent += 1;
                  if (!finalFirstSent) {
                    finalFirstSent = true;
                    perfSpan.mark("reply.final_first_sent", { bytes: utf8ByteLength(wave[i]!), chunkIndex: i + 1 });
                  }
                } catch (sendErr) {
                  finalDropped = true;
                  deps.errLog(
                    `weixin.final.dropped reason=send_failed kind=text_paginated chatKey=${to} chunk=${i + 1}/${total} err=${String(sendErr)}`,
                  );
                  break;
                }
              }
              const restToPark = prefixed.slice(sent);
              finalChunksPending = restToPark.length;
              if (restToPark.length > 0 && deps.enqueuePendingFinal) {
                const pending: PendingFinalChunk[] = restToPark.map((text, idx) =>
                  buildPendingChunk(text, sent + idx + 1, total),
                );
                deps.enqueuePendingFinal(to, pending);
                if (sent === 0) {
                  // Zero pages went out, so the in-band heads-up tail never
                  // attached anywhere — send the standalone notice instead.
                  await sendAllParkedNotice(restToPark.length);
                }
              }
            }
          }
        }
      }
      perfSpan.mark("reply.final_done", {
        chunksSent: finalChunksSent,
        chunksPending: finalChunksPending,
        dropped: finalDropped,
      });
    }
    let mediaSent = 0;
    let mediaFailed = 0;
    let mediaRejected = 0;
    let mediaDropped = 0;
    for (const mediaItem of outboundMedia) {
      const filePath = await resolveSafeMediaPath(mediaItem.filePath, [mediaStore.rootDir, resolveMediaTempDir(deps.mediaTempDir), ...(deps.allowedMediaRoots ?? [])]);
      if (!filePath) {
        mediaRejected += 1;
        deps.errLog(`outbound media rejected: path=${mediaItem.filePath}`);
        continue;
      }
      const caption = mediaItem.caption ? markdownToPlainText(mediaItem.caption) : "";
      const captionReserve = caption && deps.reserveFinal ? deps.reserveFinal(to) : true;
      if (!captionReserve) {
        deps.errLog(
          `weixin.final.dropped reason=quota_exhausted kind=media_caption chatKey=${to}`,
        );
      }
      const reservedMedia = deps.reserveFinal ? deps.reserveFinal(to) : true;
      if (!reservedMedia) {
        mediaDropped += 1;
        deps.errLog(
          `weixin.final.dropped reason=quota_exhausted kind=media chatKey=${to}`,
        );
        continue;
      }
      try {
        const sent = await sendWeixinMediaFile({
          media: mediaItem,
          filePath,
          to,
          text: captionReserve ? caption : "",
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
          cdnBaseUrl: deps.cdnBaseUrl,
        });
        mediaSent += 1;
        perfSpan.mark("reply.media_sent", {
          kind: mediaItem.kind,
          index: mediaSent + mediaFailed + mediaRejected + mediaDropped,
          messageId: sent.messageId,
        });
      } catch (err) {
        mediaFailed += 1;
        deps.errLog(`outbound media send failed: ${String(err)}`);
      }
    }
    if (outboundMedia.length > 0) {
      perfSpan.mark("reply.media_done", {
        mediaCount: outboundMedia.length,
        sent: mediaSent,
        failed: mediaFailed,
        rejected: mediaRejected,
        dropped: mediaDropped,
      });
    }
  } catch (err) {
    if (isAbortError(err)) {
      perfSpan.setOutcome("aborted", { reason: "user_cancel" });
      deps.log(`handleWeixinMessageTurn: turn aborted: ${err.message}`);
      return;
    }
    perfSpan.setOutcome("error", { reason: "turn_error" });
    const errorText = err instanceof Error ? err.stack ?? err.message : JSON.stringify(err);
    deps.errLog(`handleWeixinMessageTurn: agent or send failed: ${errorText}`);
    const errMessage = t().misc.executionError(err instanceof Error ? err.message : JSON.stringify(err));
    const errDisposition = resolveFinalDisposition(
      shouldDeliverSegment(deps.isForeground),
      Boolean(deps.boundSessionAlias && deps.onBackgroundFinal),
    );
    if (errDisposition === "store") {
      await deps.onBackgroundFinal!(deps.boundSessionAlias!, errMessage, "error");
      if (shouldSendBackgroundNotice(deps.reserveFinal ? () => deps.reserveFinal!(to) : undefined)) {
        await sendMessageWeixin({
          to,
          text: buildBackgroundCompletionNotice(deps.boundSessionAlias!, "error"),
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        }).catch((e) => deps.errLog(`bg completion notice failed: ${String(e)}`));
      } else {
        deps.errLog(`weixin.final.dropped reason=quota_exhausted kind=bg_notice chatKey=${to}`);
      }
    } else if (errDisposition === "drop") {
      deps.errLog(`weixin.final.dropped reason=backgrounded_no_store kind=error_notice chatKey=${to}`);
    } else {
      const reservedErr = deps.reserveFinal ? deps.reserveFinal(to) : true;
      if (!reservedErr) {
        deps.errLog(
          `weixin.final.dropped reason=quota_exhausted kind=error_notice chatKey=${to}`,
        );
      } else {
        void sendWeixinErrorNotice({
          to,
          contextToken,
          message: errMessage,
          baseUrl: deps.baseUrl,
          token: deps.token,
          errLog: deps.errLog,
        });
      }
    }
  } finally {
    stopTypingIndicator();
  }
    },
  );
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}
