import { defineStore } from "pinia";
import { isErrorPayload, type WebServerEvent, type TerminalAttachResult } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { sendWebClientMessage } from "../api/events";

type OutputCb = (terminalId: string, data: string, seq: number) => void;
type ExitCb = (terminalId: string, code: number) => void;

function unwrap<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) throw new Error(result.error.message || result.error.code);
  return result;
}

export const useTerminalStore = defineStore("terminal", () => {
  const outputCbs = new Set<OutputCb>();
  const exitCbs = new Set<ExitCb>();

  async function create(instanceId: string, sessionAlias: string, cols: number, rows: number): Promise<string> {
    const result = await api.rpc<{ terminalId: string }>(instanceId, "control.terminal.create", { sessionAlias, cols, rows });
    const { terminalId } = unwrap(result);
    return terminalId;
  }

  async function attach(instanceId: string, terminalId: string): Promise<TerminalAttachResult> {
    const result = await api.rpc<TerminalAttachResult>(instanceId, "control.terminal.attach", { terminalId });
    return unwrap(result);
  }

  function input(instanceId: string, terminalId: string, data: string): void {
    sendWebClientMessage({ kind: "terminal-input", instanceId, terminalId, data });
  }

  function resize(instanceId: string, terminalId: string, cols: number, rows: number): void {
    sendWebClientMessage({ kind: "terminal-resize", instanceId, terminalId, cols, rows });
  }

  function close(instanceId: string, terminalId: string): void {
    sendWebClientMessage({ kind: "terminal-close", instanceId, terminalId });
  }

  function onOutput(cb: OutputCb): () => void {
    outputCbs.add(cb);
    return () => outputCbs.delete(cb);
  }

  function onExit(cb: ExitCb): () => void {
    exitCbs.add(cb);
    return () => exitCbs.delete(cb);
  }

  function applyEvent(event: WebServerEvent): void {
    if (event.kind !== "control-event") return;
    const e = event.event;
    if (e.type === "terminal-output") {
      for (const cb of outputCbs) cb(e.terminalId, e.data, e.seq);
    } else if (e.type === "terminal-exit") {
      for (const cb of exitCbs) cb(e.terminalId, e.code);
    }
  }

  return { create, attach, input, resize, close, onOutput, onExit, applyEvent };
});
