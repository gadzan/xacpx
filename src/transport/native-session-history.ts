import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ToolUseEvent, ToolUseKind } from "../channels/types";

// Neutral (channel-agnostic) representation of a recovered native-session turn. The
// relay connector maps this to wire DTOs; WeChat etc. could render it differently.
export type NativeHistoryPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; tool: ToolUseEvent };

export interface NativeHistoryMessage {
  role: "user" | "agent";
  /** Flattened text (the `out`/`in` body); `parts` carries the ordered transcript for agents. */
  text: string;
  /** Ordered transcript for agent turns (text / reasoning / tool), as the agent produced it. */
  parts?: NativeHistoryPart[];
}

// --- acpx on-disk shapes (the subset we read) -------------------------------------
// acpx persists a faithful conversation in its session record. We read it directly
// because the bundled acpx CLI can't address a record by acp_session_id (`sessions
// show` is name-scoped and `sessions list` drops both the name and the messages).
// Shapes mirror acpx `src/types.ts` (SessionMessage union). Treated defensively —
// any shape drift just yields fewer/zero messages, never a throw that breaks attach.

interface AcpxIndexEntry {
  file: string;
  acpxRecordId?: string;
  acpSessionId?: string;
  agentCommand?: string;
  cwd?: string;
}

function classifyToolKind(name: string): ToolUseKind {
  const n = name.toLowerCase();
  if (/(^|[^a-z])(read|cat|view|open)([^a-z]|$)/.test(n)) return "read";
  if (/(grep|search|find|glob|ripgrep|rg)/.test(n)) return "search";
  if (/(edit|write|apply|patch|replace|create)/.test(n)) return "edit";
  if (/(bash|shell|exec|run|terminal|command)/.test(n)) return "execute";
  if (/(think|reason|plan)/.test(n)) return "think";
  return "other";
}

function textOfUserContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.Text === "string") out.push(o.Text);
      else if (o.Mention && typeof (o.Mention as Record<string, unknown>).content === "string") out.push(String((o.Mention as Record<string, unknown>).content));
      else if (o.Image) out.push("[image]");
      else if (o.Audio) out.push("[audio]");
    }
  }
  return out.join("\n");
}

function toolResultText(result: unknown): { text?: string; isError: boolean } {
  if (!result || typeof result !== "object") return { isError: false };
  const r = result as Record<string, unknown>;
  const isError = r.is_error === true;
  if (typeof r.output === "string") return { text: r.output, isError };
  const content = r.content as Record<string, unknown> | undefined;
  if (content && typeof content.Text === "string") return { text: content.Text, isError };
  return { isError };
}

function toolUseEventOf(toolUse: Record<string, unknown>, result: unknown): ToolUseEvent {
  const id = typeof toolUse.id === "string" ? toolUse.id : "";
  const name = typeof toolUse.name === "string" ? toolUse.name : "tool";
  const rawInput = toolUse.input ?? (typeof toolUse.raw_input === "string" ? safeParse(toolUse.raw_input) : undefined);
  const res = toolResultText(result);
  return {
    toolCallId: id,
    toolName: name,
    kind: classifyToolKind(name),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(res.text !== undefined ? { rawOutput: res.text } : {}),
    status: result ? (res.isError ? "error" : "success") : "success",
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** Map an acpx SessionMessage[] (the persisted conversation) to neutral history. The
 *  `"Resume"` marker entries are dropped. Pure + defensive: unknown shapes are skipped. */
export function mapAcpxMessagesToHistory(raw: unknown): NativeHistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeHistoryMessage[] = [];
  for (const msg of raw) {
    if (msg === "Resume" || !msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.User && typeof m.User === "object") {
      const text = textOfUserContent((m.User as Record<string, unknown>).content);
      out.push({ role: "user", text });
      continue;
    }
    if (m.Agent && typeof m.Agent === "object") {
      const agent = m.Agent as Record<string, unknown>;
      const toolResults = (agent.tool_results as Record<string, unknown>) ?? {};
      const parts: NativeHistoryPart[] = [];
      const textChunks: string[] = [];
      for (const c of Array.isArray(agent.content) ? agent.content : []) {
        if (!c || typeof c !== "object") continue;
        const o = c as Record<string, unknown>;
        if (typeof o.Text === "string") { parts.push({ kind: "text", text: o.Text }); textChunks.push(o.Text); }
        else if (o.Thinking && typeof (o.Thinking as Record<string, unknown>).text === "string") parts.push({ kind: "reasoning", text: String((o.Thinking as Record<string, unknown>).text) });
        else if (typeof o.RedactedThinking === "string") parts.push({ kind: "reasoning", text: "[redacted reasoning]" });
        else if (o.ToolUse && typeof o.ToolUse === "object") {
          const tu = o.ToolUse as Record<string, unknown>;
          const result = typeof tu.id === "string" ? toolResults[tu.id] : undefined;
          parts.push({ kind: "tool", tool: toolUseEventOf(tu, result) });
        }
      }
      out.push({ role: "agent", text: textChunks.join("\n\n"), ...(parts.length ? { parts } : {}) });
    }
  }
  return out;
}

export interface ReadNativeHistoryOptions {
  agentSessionId: string;
  agentCommand?: string;
  /** Override for the acpx sessions dir (tests). Defaults to `<home>/.acpx/sessions`. */
  sessionsDir?: string;
  homeDir?: string;
}

/** Recover a native (agent-side) session's prior conversation from acpx's own persisted
 *  record. Best-effort: any I/O or shape problem yields `[]` so a native attach never
 *  fails just because history couldn't be read. When several records share the same
 *  acp_session_id (the source record + the freshly-created empty attach record), the
 *  one with the most messages wins — i.e. the real history, not the empty stub. */
export async function readNativeSessionHistory(opts: ReadNativeHistoryOptions): Promise<NativeHistoryMessage[]> {
  try {
    const dir = opts.sessionsDir ?? join(opts.homeDir ?? homedir(), ".acpx", "sessions");
    const indexRaw = await readFile(join(dir, "index.json"), "utf8").catch(() => null);
    if (!indexRaw) return [];
    const index = JSON.parse(indexRaw) as { entries?: AcpxIndexEntry[] };
    const candidates = (index.entries ?? []).filter(
      (e) => e.acpSessionId === opts.agentSessionId && (!opts.agentCommand || !e.agentCommand || e.agentCommand === opts.agentCommand),
    );
    let best: NativeHistoryMessage[] = [];
    for (const entry of candidates) {
      if (!entry.file) continue;
      const recRaw = await readFile(join(dir, entry.file), "utf8").catch(() => null);
      if (!recRaw) continue;
      const record = JSON.parse(recRaw) as { messages?: unknown };
      const mapped = mapAcpxMessagesToHistory(record.messages);
      if (mapped.length > best.length) best = mapped;
    }
    return best;
  } catch {
    return [];
  }
}
