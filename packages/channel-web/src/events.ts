import { MSG, type ControlEventDto, type InstanceNoticePayload, type WebServerEvent } from "@ganglion/xacpx-relay-protocol";

import { LOCAL_INSTANCE_ID } from "./config.js";

/** A missing key is global. `bot:` is a conversation. Anything else must be this channel. */
export function isLocalScope(chatKey: unknown): boolean {
  if (typeof chatKey !== "string" || chatKey.length === 0) return true;
  return chatKey.startsWith("web:") || chatKey.startsWith("bot:");
}

export function eventChatKey(type: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  if (type === MSG.instanceEvent) {
    const event = (payload as { event?: { chatKey?: unknown } }).event;
    return event?.chatKey;
  }
  return (payload as { chatKey?: unknown }).chatKey;
}

/** Unwrap a control-bridge event into the shape the dashboard already parses. */
export function toWebEvent(type: string, payload: unknown): WebServerEvent | null {
  if (type === MSG.instanceEvent) {
    const event = payload && typeof payload === "object" ? (payload as { event?: unknown }).event : undefined;
    if (!event || typeof event !== "object") return null;
    return { kind: "control-event", instanceId: LOCAL_INSTANCE_ID, event: event as ControlEventDto };
  }
  if (type === MSG.instanceNotice) {
    return { kind: "notice", instanceId: LOCAL_INSTANCE_ID, notice: payload as InstanceNoticePayload };
  }
  return null;
}
