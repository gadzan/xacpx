import { defineStore } from "pinia";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { sendWebClientMessage } from "../api/events";

type OutputCb = (terminalId: string, data: string) => void;
type ExitCb = (terminalId: string, code: number) => void;

export const useTerminalStore = defineStore("terminal", () => {
  const outputCbs = new Set<OutputCb>();
  const exitCbs = new Set<ExitCb>();

  async function create(instanceId: string, sessionAlias: string, cols: number, rows: number): Promise<string> {
    const { terminalId } = await api.rpc<{ terminalId: string }>(instanceId, "control.terminal.create", { sessionAlias, cols, rows });
    return terminalId;
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
      for (const cb of outputCbs) cb(e.terminalId, e.data);
    } else if (e.type === "terminal-exit") {
      for (const cb of exitCbs) cb(e.terminalId, e.code);
    }
  }

  return { create, input, resize, close, onOutput, onExit, applyEvent };
});
