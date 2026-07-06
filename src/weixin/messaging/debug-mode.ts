/**
 * Per-bot debug mode toggle, persisted to disk so it survives gateway restarts.
 *
 * State file: `<stateDir>/openclaw-weixin/debug-mode.json`
 * Format:     `{ "accounts": { "<accountId>": true, ... } }`
 *
 * When enabled, handleWeixinMessageTurn appends a timing summary after each
 * AI reply is delivered to the user.
 */
import fs from "node:fs";
import path from "node:path";

import { ensureDirSync } from "../storage/ensure-dir.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { weixinLog } from "../util/weixin-log";

interface DebugModeState {
  accounts: Record<string, boolean>;
}

function resolveDebugModePath(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "debug-mode.json");
}

function loadState(): DebugModeState {
  try {
    const raw = fs.readFileSync(resolveDebugModePath(), "utf-8");
    const parsed = JSON.parse(raw) as DebugModeState;
    if (parsed && typeof parsed.accounts === "object") return parsed;
  } catch {
    // missing or corrupt — start fresh
  }
  return { accounts: {} };
}

function saveState(state: DebugModeState): void {
  const filePath = resolveDebugModePath();
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/** Toggle debug mode for a bot account. Returns the new state. */
export function toggleDebugMode(accountId: string): boolean {
  const state = loadState();
  const next = !state.accounts[accountId];
  state.accounts[accountId] = next;
  try {
    saveState(state);
  } catch (err) {
    weixinLog.error("weixin.message.debug_mode_persist_failed", "debug-mode: failed to persist state", {
      accountId,
      error: String(err),
    });
  }
  return next;
}

/** Check whether debug mode is active for a bot account. */
export function isDebugMode(accountId: string): boolean {
  return loadState().accounts[accountId] === true;
}

/**
 * Reset internal state — only for tests.
 * @internal
 */
export function _resetForTest(): void {
  try {
    fs.unlinkSync(resolveDebugModePath());
  } catch {
    // ignore if not present
  }
}
