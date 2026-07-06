/**
 * Weixin 斜杠指令处理模块
 *
 * 支持的指令：
 * - /echo <message>         直接回复消息（不经过 AI），并附带通道耗时统计
 * - /toggle-debug           开关 debug 模式，启用后每条 AI 回复追加全链路耗时
 * - /clear                  清除当前会话，重新开始对话
 *
 * 注意：聊天侧不提供 /logout —— 任何能给 bot 发消息的用户都不应有清除
 * 凭证的权限；退出登录只能通过 CLI（`xacpx logout`）。
 */
import type { WeixinApiOptions } from "../api/api.js";
import { weixinLog } from "../util/weixin-log";
import { t } from "../../i18n/index.js";

import { buildFinalHeadsUp } from "./final-heads-up.js";
import type { PendingFinalChunk } from "./quota-manager.js";
import { toggleDebugMode, isDebugMode } from "./debug-mode.js";
import { sendMessageWeixin } from "./send.js";

export interface SlashCommandResult {
  /** 是否是斜杠指令（true 表示已处理，不需要继续走 AI） */
  handled: boolean;
}

export interface SlashCommandContext {
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** Called when /clear is invoked to reset the agent session. */
  onClear?: () => void | Promise<void>;
  // v1.4: pending-final pagination wiring. Optional because not every code
  // path that constructs a SlashCommandContext needs /jx drain (smoke tests,
  // /echo-only flows). When provided, /jx will pull the next wave from the
  // pending queue and send it.
  hasPendingFinal?: (chatKey: string) => boolean;
  drainPendingFinal?: (chatKey: string, available: number) => PendingFinalChunk[];
  prependPendingFinal?: (chatKey: string, chunks: PendingFinalChunk[]) => void;
  reserveFinal?: (chatKey: string) => boolean;
  finalRemaining?: (chatKey: string) => number;
  // Optional override for the underlying send. Defaults to sendMessageWeixin
  // when omitted; primarily useful for tests that cannot rely on module-level
  // mocking due to shared module cache across test files.
  sendText?: (params: {
    to: string;
    text: string;
    contextToken?: string;
  }) => Promise<void>;
}

/** 发送回复消息 */
async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
}

/** 处理 /echo 指令 */
async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    t().weixin.echoTimingHeader,
    t().weixin.echoTimingEventTime(eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"),
    t().weixin.echoTimingPlatformDelay(platformDelay),
    t().weixin.echoTimingPluginDelay(Date.now() - receivedAt),
  ].join("\n");
  await sendReply(ctx, timing);
}

/**
 * v1.4: drain the next wave of pending paginated-final chunks parked by an
 * earlier inbound's overflow. Sends up to `finalRemaining(chatKey)` chunks; if
 * any chunks remain after the wave, appends a heads-up tail to this wave's
 * last chunk so the user knows another `/jx` will pull more. No-op when there
 * is nothing pending or the wiring is incomplete.
 */
export async function drainPendingFinalForJx(ctx: SlashCommandContext): Promise<void> {
  if (
    !ctx.hasPendingFinal ||
    !ctx.drainPendingFinal ||
    !ctx.prependPendingFinal ||
    !ctx.reserveFinal ||
    !ctx.finalRemaining
  ) {
    return;
  }
  if (!ctx.hasPendingFinal(ctx.to)) return;
  const available = ctx.finalRemaining(ctx.to);
  if (available <= 0) return;
  const wave = ctx.drainPendingFinal(ctx.to, available);
  if (wave.length === 0) return;
  const sendWave = wave.map((chunk) => ({ ...chunk }));
  const stillPending = ctx.hasPendingFinal(ctx.to);
  if (stillPending) {
    const last = sendWave[sendWave.length - 1]!;
    last.text = `${last.text}\n\n${buildFinalHeadsUp({
      total: last.total,
      sentSoFar: last.seq,
    })}`;
  }
  const send = ctx.sendText
    ? ctx.sendText
    : (params: { to: string; text: string; contextToken?: string }) =>
        sendMessageWeixin({
          to: params.to,
          text: params.text,
          opts: {
            baseUrl: ctx.baseUrl,
            token: ctx.token,
            contextToken: params.contextToken,
          },
        }).then(() => undefined);
  let sent = 0;
  for (const chunk of sendWave) {
    const reserved = ctx.reserveFinal(ctx.to);
    if (!reserved) {
      ctx.prependPendingFinal(ctx.to, wave.slice(sent));
      ctx.errLog(
        `weixin.final.dropped reason=quota_exhausted kind=text_paginated_jx chatKey=${ctx.to} chunk=${chunk.seq}/${chunk.total}`,
      );
      break;
    }
    try {
      const sendArgs: { to: string; text: string; contextToken?: string } = {
        to: ctx.to,
        text: chunk.text,
      };
      const ct = chunk.contextToken ?? ctx.contextToken;
      if (ct !== undefined) sendArgs.contextToken = ct;
      await send(sendArgs);
      sent += 1;
    } catch (err) {
      ctx.prependPendingFinal(ctx.to, wave.slice(sent));
      ctx.errLog(
        `weixin.final.dropped reason=send_failed kind=text_paginated_jx chatKey=${ctx.to} chunk=${chunk.seq}/${chunk.total} err=${String(err)}`,
      );
      break;
    }
  }
}

/**
 * 尝试处理斜杠指令
 *
 * @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
 */
export async function handleSlashCommand(
  content: string,
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  // args may hold user message text (e.g. /echo's payload) — never logged.
  weixinLog.info("weixin.message.slash_command_received", "Slash command received", {
    command: command.slice(0, 32),
  });

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? t().weixin.debugEnabled
            : t().weixin.debugDisabled,
        );
        return { handled: true };
      }
      case "/clear": {
        await ctx.onClear?.();
        await sendReply(ctx, t().weixin.sessionCleared);
        return { handled: true };
      }
      case "/jx": {
        // v1.4: monitor.onInbound has already reset the budget window. If a
        // long final answer overflowed previously and parked chunks in the
        // pending queue, drain the next wave (up to finalRemaining slots) and
        // send it now. If pending is empty, this remains a pure no-op (no
        // reply burned on an ack).
        await drainPendingFinalForJx(ctx);
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  } catch (err) {
    weixinLog.error("weixin.message.slash_command_failed", "Slash command error", {
      command: command.slice(0, 32),
      error: String(err),
    });
    try {
      await sendReply(ctx, t().weixin.commandFailed(String(err).slice(0, 200)));
    } catch {
      // send of error message also failed; log only
    }
    return { handled: true };
  }
}
