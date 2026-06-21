import type { OrchestrationTaskStatus } from "../orchestration/orchestration-types";
import { isKnownXacpxCommandPrefix } from "./command-list";

export interface TaskListFilter {
  status?: OrchestrationTaskStatus;
  stuck?: boolean;
  sort?: "updatedAt" | "createdAt";
  order?: "asc" | "desc";
}

export interface GroupListFilter {
  status?: "pending" | "running" | "terminal";
  stuck?: boolean;
  sort?: "updatedAt" | "createdAt";
  order?: "asc" | "desc";
}

export type ParsedCommand =
  | { kind: "help"; topic?: string }
  | { kind: "agents" }
  | { kind: "agent.add"; template: string; model?: string }
  | { kind: "agent.rm"; name: string }
  | { kind: "permission.status" }
  | { kind: "permission.mode.set"; mode: "approve-all" | "approve-reads" | "deny-all" }
  | { kind: "permission.auto.status" }
  | { kind: "permission.auto.set"; policy: "deny" | "fail" }
  | { kind: "config.show" }
  | { kind: "config.set"; path: string; value: string }
  | { kind: "workspaces" }
  | { kind: "workspace.new"; name: string; cwd: string; raw?: boolean }
  | { kind: "workspace.rm"; name: string }
  | { kind: "sessions" }
  | { kind: "status" }
  | { kind: "cancel"; alias?: string }
  | { kind: "session.reset" }
  | { kind: "session.tail"; lines?: number }
  | { kind: "session.rm"; alias: string }
  | { kind: "session.archive"; alias: string }
  | { kind: "delegate.request"; targetAgent: string; role?: string; groupId?: string; task: string }
  | { kind: "groups"; filter?: GroupListFilter }
  | { kind: "group.new"; title: string }
  | { kind: "group.get"; groupId: string }
  | { kind: "group.cancel"; groupId: string }
  | { kind: "group.delegate"; groupId: string; targetAgent: string; role?: string; task: string }
  | { kind: "tasks"; filter?: TaskListFilter }
  | { kind: "tasks.clean" }
  | { kind: "task.get"; taskId: string }
  | { kind: "task.approve"; taskId: string }
  | { kind: "task.reject"; taskId: string }
  | { kind: "task.cancel"; taskId: string }
  | { kind: "mode.show" }
  | { kind: "mode.set"; modeId: string }
  | { kind: "model.show" }
  | { kind: "model.set"; modelId: string }
  | { kind: "replymode.show" }
  | { kind: "replymode.set"; replyMode: "stream" | "final" | "verbose" }
  | { kind: "replymode.reset" }
  | { kind: "session.use"; alias: string }
  | { kind: "session.use.previous" }
  | { kind: "session.new"; alias: string; agent: string; workspace: string; model?: string }
  | { kind: "session.shortcut"; agent: string; cwd?: string; workspace?: string }
  | { kind: "session.shortcut.new"; agent: string; cwd?: string; workspace?: string }
  | { kind: "session.attach"; alias: string; agent: string; workspace: string; transportSession: string }
  | { kind: "session.native.list"; agent?: string; cwd?: string; workspace?: string; all?: boolean; cursor?: string }
  | { kind: "session.native.select"; identifier: string; alias?: string }
  | { kind: "session.native.attach"; identifier: string; alias?: string }
  | { kind: "later.help" }
  // tokens: quote-stripped values for structured parsing (flags, time spec).
  // tails: parallel array; tails[i] is the verbatim input from token i to the
  // end — the message body must be taken from here, never re-joined from tokens.
  | { kind: "later.create"; tokens: string[]; tails: string[] }
  | { kind: "later.list" }
  | { kind: "later.cancel"; id: string }
  | { kind: "invalid"; text: string; recognizedCommand: string }
  | { kind: "prompt"; text: string };

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { kind: "prompt", text: trimmed };
  }

  const tokens = tokenizeCommand(trimmed);
  const parts = tokens.map((token) => token.value);
  // Verbatim tail of the input starting at token `index` — quote characters
  // and internal spacing intact. Free-text bodies (messages, task texts,
  // titles) MUST use this; rebuilding them via parts.join(" ") silently
  // rewrites user content (tokenization strips quotes and collapses spaces).
  const rawTail = (index: number): string =>
    index < tokens.length ? trimmed.slice(tokens[index]?.start ?? 0) : "";
  const command = normalizeCommand(parts[0] ?? "");

  if (command === "/help" && parts.length === 1) return { kind: "help" };
  if (command === "/help" && parts.length === 2) return { kind: "help", topic: parts[1] };
  if (command === "/agents") return { kind: "agents" };
  if (command === "/workspaces") return { kind: "workspaces" };
  if (command === "/sessions") return { kind: "sessions" };
  if (command === "/tasks" && parts[1] === "clean" && parts.length === 2) return { kind: "tasks.clean" };

  if (command === "/tasks" && parts[1] !== "clean") {
    const { filter, ok } = parseListFilterFlags(parts, TASK_STATUS_VALUES);
    if (ok) {
      return Object.keys(filter).length > 0
        ? { kind: "tasks", filter: filter as TaskListFilter }
        : { kind: "tasks" };
    }
  }

  if (command === "/groups") {
    const { filter, ok } = parseListFilterFlags(parts, GROUP_STATUS_VALUES);
    if (ok) {
      return Object.keys(filter).length > 0
        ? { kind: "groups", filter: filter as GroupListFilter }
        : { kind: "groups" };
    }
  }

  if (command === "/status") return { kind: "status" };
  if (command === "/cancel") {
    // /cancel and its alias /stop accept an optional trailing alias token to
    // target a specific (incl. background) session; bare /cancel keeps the
    // foreground-session shape (no alias field).
    const alias = parts[1];
    return alias ? { kind: "cancel", alias } : { kind: "cancel" };
  }
  if (command === "/clear") return { kind: "session.reset" };
  if (command === "/mode" && parts.length === 1) return { kind: "mode.show" };
  if (command === "/model" && parts.length === 1) return { kind: "model.show" };
  if (command === "/replymode" && parts.length === 1) return { kind: "replymode.show" };
  if (command === "/config" && parts.length === 1) return { kind: "config.show" };
  if (command === "/permission" && parts.length === 1) return { kind: "permission.status" };
  if (command === "/session" && parts.length === 1) return { kind: "sessions" };
  if (command === "/workspace" && parts.length === 1) return { kind: "workspaces" };
  if (command === "/session" && parts[1] === "reset" && parts.length === 2) return { kind: "session.reset" };
  if (command === "/session" && parts[1] === "tail") {
    if (parts.length === 2) {
      return { kind: "session.tail" };
    }
    if (parts.length === 3) {
      const lines = parsePositiveInt(parts[2]);
      if (lines !== null) {
        return { kind: "session.tail", lines };
      }
    }
    return { kind: "invalid", text: trimmed, recognizedCommand: "/session" };
  }
  if (command === "/session" && parts[1] === "rm" && parts[2] && parts.length === 3) {
    return { kind: "session.rm", alias: parts[2] };
  }
  if (command === "/session" && parts[1] === "archive" && parts[2] && parts.length === 3) {
    return { kind: "session.archive", alias: parts[2] };
  }
  if (command === "/ssn") {
    if (parts.length === 1) {
      return { kind: "session.native.list" };
    }

    const identifier = parts[1] ?? "";
    if (/^\d+$/.test(identifier)) {
      // /ssn <n> [-a <alias>] — reuse the attach tail parser for the optional alias.
      const selected = readNativeAttachCommand(parts, 1);
      if (!selected) {
        return { kind: "invalid", text: trimmed, recognizedCommand: "/ssn" };
      }
      return selected.alias
        ? { kind: "session.native.select", identifier, alias: selected.alias }
        : { kind: "session.native.select", identifier };
    }

    if (parts[1] === "attach") {
      if (!parts[2]) {
        return { kind: "invalid", text: trimmed, recognizedCommand: "/ssn" };
      }
      const attached = readNativeAttachCommand(parts, 2);
      if (attached) {
        return attached;
      }
      return { kind: "invalid", text: trimmed, recognizedCommand: "/ssn" };
    }

    const nativeList = readNativeListCommand(parts, 1);
    if (nativeList) {
      return nativeList;
    }
    return { kind: "invalid", text: trimmed, recognizedCommand: "/ssn" };
  }
  if (command === "/session" && parts[1] === "native") {
    const nativeList = readNativeListCommand(parts, 2);
    if (nativeList) {
      return nativeList;
    }
    return { kind: "invalid", text: trimmed, recognizedCommand: "/session" };
  }
  if (command === "/session" && parts[1] === "attach" && parts[2] === "native") {
    if (!parts[3]) {
      return { kind: "invalid", text: trimmed, recognizedCommand: "/session" };
    }
    const attached = readNativeAttachCommand(parts, 3);
    if (attached) {
      return attached;
    }
    return { kind: "invalid", text: trimmed, recognizedCommand: "/session" };
  }

  if (command === "/group" && parts[1] === "new" && parts.length > 2) {
    const title = rawTail(2);
    if (title.trim().length > 0) {
      return { kind: "group.new", title };
    }
  }

  if (command === "/group" && parts[1] === "cancel" && parts.length === 3) {
    return { kind: "group.cancel", groupId: parts[2] ?? "" };
  }

  if (command === "/group" && parts[1] === "add" && parts.length >= 4) {
    const groupId = parts[2] ?? "";
    const targetAgent = parts[3] ?? "";
    let role: string | undefined;
    let index = 4;
    while (index < parts.length) {
      if (parts[index] === "--role") {
        role = parts[index + 1];
        if (!role) {
          break;
        }
        index += 2;
        continue;
      }
      break;
    }
    const task = rawTail(index);
    if (groupId.trim().length > 0 && targetAgent.trim().length > 0 && task.trim().length > 0) {
      return {
        kind: "group.delegate",
        groupId,
        targetAgent,
        ...(role ? { role } : {}),
        task,
      };
    }
  }

  if (command === "/group" && parts[1] && parts[1] !== "new" && parts[1] !== "cancel" && parts[1] !== "add" && parts.length === 2) {
    return { kind: "group.get", groupId: parts[1] };
  }

  if (command === "/permission" && parts[1] === "set") {
    const mode = toPermissionMode(parts[2] ?? "");
    if (mode) {
      return { kind: "permission.mode.set", mode };
    }
  }

  if (command === "/permission" && parts[1] === "auto") {
    if (parts.length === 2) {
      return { kind: "permission.auto.status" };
    }

    const policy = toNonInteractivePermission(parts[2] ?? "");
    if (policy) {
      return { kind: "permission.auto.set", policy };
    }
  }

  if (command === "/config" && parts[1] === "set" && parts.length === 4) {
    return { kind: "config.set", path: parts[2] ?? "", value: parts[3] ?? "" };
  }

  if (command === "/use" && parts[1] === "-") {
    return { kind: "session.use.previous" };
  }

  if (command === "/use" && parts[1]) {
    return { kind: "session.use", alias: parts[1] };
  }

  if (command === "/mode" && parts[1]) {
    return { kind: "mode.set", modeId: parts[1] };
  }

  if (command === "/model" && parts[1]) {
    return { kind: "model.set", modelId: parts.slice(1).join(" ") };
  }

  if (command === "/replymode" && parts[1] === "reset" && parts.length === 2) {
    return { kind: "replymode.reset" };
  }
  if (command === "/replymode" && (parts[1] === "stream" || parts[1] === "final" || parts[1] === "verbose") && parts.length === 2) {
    return { kind: "replymode.set", replyMode: parts[1] };
  }

  if (command === "/agent" && parts[1] === "add" && parts[2]) {
    // Optional `--model <id>` / `-m <id>` sets the agent's default model.
    let model = "";
    for (let index = 3; index < parts.length; index += 1) {
      if ((parts[index] === "--model" || parts[index] === "-m") && index + 1 < parts.length) {
        model = parts[index + 1] ?? "";
        index += 1;
      }
    }
    return model.trim().length > 0
      ? { kind: "agent.add", template: parts[2], model: model.trim() }
      : { kind: "agent.add", template: parts[2] };
  }

  if (command === "/agent" && parts[1] === "rm" && parts[2]) {
    return { kind: "agent.rm", name: parts[2] };
  }

  if ((command === "/delegate" || command === "/dg") && parts[1]) {
    const parsedDelegate = parseDelegateRequest(parts, rawTail);
    if (parsedDelegate) {
      return parsedDelegate;
    }
  }

  if (command === "/task" && parts[1] === "approve") {
    if (parts[2] && parts.length === 3) {
      return { kind: "task.approve", taskId: parts[2] };
    }
  } else if (command === "/task" && parts[1] === "reject") {
    if (parts[2] && parts.length === 3) {
      return { kind: "task.reject", taskId: parts[2] };
    }
  } else if (command === "/task" && parts[1] === "cancel") {
    if (parts[2] && parts.length === 3) {
      return { kind: "task.cancel", taskId: parts[2] };
    }
  } else if (command === "/task" && parts[1] && parts.length === 2) {
    return { kind: "task.get", taskId: parts[1] };
  }

  if (command === "/later") {
    if (parts.length === 1) return { kind: "later.help" };
    if (parts[1] === "list" && parts.length === 2) return { kind: "later.list" };
    if (parts[1] === "cancel" && parts[2] && parts.length === 3) {
      return { kind: "later.cancel", id: parts[2] };
    }
    return {
      kind: "later.create",
      tokens: parts.slice(1),
      tails: tokens.slice(1).map((_, index) => rawTail(index + 1)),
    };
  }

  if (command === "/workspace" && parts[1] === "new" && parts[2]) {
    const name = parts[2];
    let cwd = "";
    let raw = false;
    let invalid = false;

    for (let index = 3; index < parts.length; index += 1) {
      if (parts[index] === "--cwd" || parts[index] === "-d") {
        if (index + 1 >= parts.length) {
          invalid = true;
          break;
        }
        cwd = parts[index + 1] ?? "";
        index += 1;
        continue;
      }

      if (parts[index] === "--raw") {
        if (raw) {
          invalid = true;
          break;
        }
        raw = true;
        continue;
      }

      invalid = true;
      break;
    }

    if (!invalid && name.trim().length > 0 && cwd.trim().length > 0) {
      return { kind: "workspace.new", name, cwd, ...(raw ? { raw: true } : {}) };
    }
  }

  if (command === "/workspace" && parts[1] === "rm" && parts[2]) {
    return { kind: "workspace.rm", name: parts[2] };
  }

  if (command === "/session" && parts[1] === "new" && parts[2]) {
    if (hasAnyFlag(parts, ["--agent", "-a"])) {
      const alias = parts[2];
      let agent = "";
      let workspace = "";
      let model = "";
      let invalid = false;

      for (let index = 3; index < parts.length; index += 1) {
        if (parts[index] === "--agent" || parts[index] === "-a") {
          if (index + 1 >= parts.length) {
            invalid = true;
            break;
          }
          agent = parts[index + 1] ?? "";
          index += 1;
          continue;
        } else if (parts[index] === "--ws" || parts[index] === "-ws") {
          if (index + 1 >= parts.length) {
            invalid = true;
            break;
          }
          workspace = parts[index + 1] ?? "";
          index += 1;
          continue;
        } else if (parts[index] === "--model" || parts[index] === "-m") {
          if (index + 1 >= parts.length) {
            invalid = true;
            break;
          }
          model = parts[index + 1] ?? "";
          index += 1;
          continue;
        }

        invalid = true;
        break;
      }

      if (!invalid && alias.trim().length > 0 && agent.trim().length > 0 && workspace.trim().length > 0) {
        return model.trim().length > 0
          ? { kind: "session.new", alias, agent, workspace, model: model.trim() }
          : { kind: "session.new", alias, agent, workspace };
      }
    }

    const shortcutTarget = readSessionShortcutTarget(parts, 3);
    if (shortcutTarget) {
      return { kind: "session.shortcut.new", agent: parts[2], ...shortcutTarget };
    }
  }

  if (command === "/session" && parts[1] && parts[1] !== "new" && parts[1] !== "attach" && parts[1] !== "reset" && parts[1] !== "rm" && parts[1] !== "archive") {
    const shortcutTarget = readSessionShortcutTarget(parts, 2);
    if (shortcutTarget) {
      return { kind: "session.shortcut", agent: parts[1], ...shortcutTarget };
    }
  }

  if (command === "/session" && parts[1] === "attach" && parts[2]) {
    const alias = parts[2];
    let agent = "";
    let workspace = "";
    let transportSession = "";
    let invalid = false;

    for (let index = 3; index < parts.length; index += 1) {
      if (parts[index] === "--agent" || parts[index] === "-a") {
        if (index + 1 >= parts.length) {
          invalid = true;
          break;
        }
        agent = parts[index + 1] ?? "";
        index += 1;
        continue;
      } else if (parts[index] === "--ws" || parts[index] === "-ws") {
        if (index + 1 >= parts.length) {
          invalid = true;
          break;
        }
        workspace = parts[index + 1] ?? "";
        index += 1;
        continue;
      } else if (parts[index] === "--name") {
        if (index + 1 >= parts.length) {
          invalid = true;
          break;
        }
        transportSession = parts[index + 1] ?? "";
        index += 1;
        continue;
      }

      invalid = true;
      break;
    }

    if (
      !invalid &&
      alias.trim().length > 0 &&
      agent.trim().length > 0 &&
      workspace.trim().length > 0 &&
      transportSession.trim().length > 0
    ) {
      return { kind: "session.attach", alias, agent, workspace, transportSession };
    }
  }

  // 如果命令前缀被识别但参数不匹配任何子命令，返回 invalid
  if (command.startsWith("/") && isRecognizedCommand(command)) {
    return { kind: "invalid", text: trimmed, recognizedCommand: command };
  }

  return { kind: "prompt", text: trimmed };
}

function hasAnyFlag(parts: string[], flags: string[]): boolean {
  return parts.some((part) => flags.includes(part));
}

function readFlagValue(parts: string[], flags: string[]): string {
  for (let index = 0; index < parts.length; index += 1) {
    if (flags.includes(parts[index] ?? "")) {
      return parts[index + 1] ?? "";
    }
  }

  return "";
}

function readSessionShortcutTarget(
  parts: string[],
  startIndex: number,
): { cwd: string } | { workspace: string } | null {
  let cwd = "";
  let workspace = "";
  let invalid = false;

  for (let index = startIndex; index < parts.length; index += 1) {
    if (parts[index] === "--cwd" || parts[index] === "-d") {
      if (index + 1 >= parts.length || workspace) {
        invalid = true;
        break;
      }
      cwd = parts[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (parts[index] === "--ws" || parts[index] === "-ws") {
      if (index + 1 >= parts.length || cwd) {
        invalid = true;
        break;
      }
      workspace = parts[index + 1] ?? "";
      index += 1;
      continue;
    }

    invalid = true;
    break;
  }

  if (invalid) {
    return null;
  }

  if (cwd.trim().length > 0) {
    return { cwd };
  }

  if (workspace.trim().length > 0) {
    return { workspace };
  }

  return null;
}

function readNativeListCommand(
  parts: string[],
  startIndex: number,
): { kind: "session.native.list"; agent?: string; cwd?: string; workspace?: string; all?: boolean; cursor?: string } | null {
  let agent = "";
  let cwd = "";
  let workspace = "";
  let all = false;
  let cursor = "";
  let invalid = false;

  if (startIndex < parts.length && !parts[startIndex]?.startsWith("-")) {
    agent = parts[startIndex] ?? "";
    startIndex += 1;
  }

  for (let index = startIndex; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "--all") {
      all = true;
      continue;
    }
    if (part === "--cursor") {
      const value = parts[index + 1] ?? "";
      if (index + 1 >= parts.length || value.startsWith("-")) {
        invalid = true;
        break;
      }
      cursor = value;
      index += 1;
      continue;
    }
    if (part === "--cwd" || part === "-d") {
      const value = parts[index + 1] ?? "";
      if (index + 1 >= parts.length || value.startsWith("-") || workspace) {
        invalid = true;
        break;
      }
      cwd = value;
      index += 1;
      continue;
    }
    if (part === "--ws" || part === "-ws") {
      const value = parts[index + 1] ?? "";
      if (index + 1 >= parts.length || value.startsWith("-") || cwd) {
        invalid = true;
        break;
      }
      workspace = value;
      index += 1;
      continue;
    }
    invalid = true;
    break;
  }

  if (invalid) {
    return null;
  }

  const result: { kind: "session.native.list"; agent?: string; cwd?: string; workspace?: string; all?: boolean; cursor?: string } = {
    kind: "session.native.list",
  };

  if (agent.trim().length > 0) result.agent = agent;
  if (cwd.trim().length > 0) result.cwd = cwd;
  if (workspace.trim().length > 0) result.workspace = workspace;
  if (all) result.all = true;
  if (cursor.trim().length > 0) result.cursor = cursor;

  return Object.keys(result).length > 1 ? result : { kind: "session.native.list" };
}

function readNativeAttachCommand(
  parts: string[],
  identifierIndex: number,
): { kind: "session.native.attach"; identifier: string; alias?: string } | null {
  const identifier = parts[identifierIndex] ?? "";
  let alias = "";

  for (let index = identifierIndex + 1; index < parts.length; index += 1) {
    if (parts[index] === "-a" || parts[index] === "--alias") {
      const value = parts[index + 1] ?? "";
      if (index + 1 >= parts.length || value.startsWith("-")) {
        return null;
      }
      alias = value;
      index += 1;
      continue;
    }

    return null;
  }

  if (identifier.trim().length === 0 || identifier.startsWith("-")) {
    return null;
  }

  if (alias.trim().length > 0) {
    return { kind: "session.native.attach", identifier, alias };
  }

  return { kind: "session.native.attach", identifier };
}

function normalizeCommand(command: string): string {
  // Only the leading command word is case-insensitive (mobile keyboards
  // auto-capitalize). Arguments and subcommand tokens keep their case:
  // aliases, workspace names and paths are case-sensitive.
  const lowered = command.toLowerCase();
  if (lowered === "/ss") return "/session";
  if (lowered === "/ws") return "/workspace";
  if (lowered === "/pm") return "/permission";
  if (lowered === "/stop") return "/cancel";
  if (lowered === "/lt") return "/later";
  return lowered;
}

function isRecognizedCommand(command: string): boolean {
  return isKnownXacpxCommandPrefix(command);
}

function toPermissionMode(value: string): "approve-all" | "approve-reads" | "deny-all" | null {
  if (value === "allow") return "approve-all";
  if (value === "read") return "approve-reads";
  if (value === "deny") return "deny-all";
  return null;
}

function toNonInteractivePermission(value: string): "deny" | "fail" | null {
  if (value === "deny" || value === "fail") {
    return value;
  }

  return null;
}

// Opening quote char → the only char that closes it. Includes curly and
// full-width variants that mobile keyboards auto-substitute. A straight quote
// never closes a curly quote (and vice versa); closing-only chars (” ’)
// outside a quote are literal characters.
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "“": "”", // “ … ”
  "‘": "’", // ‘ … ’
  "＂": "＂", // ＂ … ＂
};

interface CommandToken {
  /** Token value with quote characters stripped (structured-arg semantics). */
  value: string;
  /**
   * Code-unit offset of the token's first source character in the tokenized
   * string — the opening quote itself when the token starts quoted. Lets
   * free-text consumers slice the original input verbatim from a token.
   */
  start: number;
}

function tokenizeCommand(input: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let current = "";
  let start = -1;
  let closingQuote: string | null = null;
  let offset = 0;

  for (const char of input) {
    const charStart = offset;
    offset += char.length;

    if (closingQuote) {
      if (char === closingQuote) {
        closingQuote = null;
      } else {
        current += char;
      }
      continue;
    }

    const close = QUOTE_PAIRS[char];
    if (close) {
      if (start === -1) start = charStart;
      closingQuote = close;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push({ value: current, start });
        current = "";
      }
      // An empty quoted pair ("" etc.) produces no token; drop its offset too.
      start = -1;
      continue;
    }

    if (start === -1) start = charStart;
    current += char;
  }

  if (current.length > 0) {
    tokens.push({ value: current, start });
  }

  return tokens;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

const TASK_STATUS_VALUES = [
  "pending",
  "needs_confirmation",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

const GROUP_STATUS_VALUES = ["pending", "running", "terminal"] as const;

function parseListFilterFlags(
  parts: string[],
  validStatuses: readonly string[],
): { filter: Record<string, unknown>; ok: boolean } {
  const filter: Record<string, unknown> = {};
  let i = 1;
  while (i < parts.length) {
    const flag = parts[i];
    if (flag === "--stuck") {
      filter.stuck = true;
      i += 1;
      continue;
    }
    if (flag === "--status" && parts[i + 1] && validStatuses.includes(parts[i + 1] ?? "")) {
      filter.status = parts[i + 1];
      i += 2;
      continue;
    }
    if (flag === "--sort" && (parts[i + 1] === "updatedAt" || parts[i + 1] === "createdAt")) {
      filter.sort = parts[i + 1];
      i += 2;
      continue;
    }
    if (flag === "--order" && (parts[i + 1] === "asc" || parts[i + 1] === "desc")) {
      filter.order = parts[i + 1];
      i += 2;
      continue;
    }
    return { filter, ok: false };
  }
  return { filter, ok: true };
}

function parseDelegateRequest(
  parts: string[],
  rawTail: (index: number) => string,
): Extract<ParsedCommand, { kind: "delegate.request" }> | null {
  const targetAgent = parts[1];
  if (!targetAgent) {
    return null;
  }

  let role: string | undefined;
  let groupId: string | undefined;
  let index = 2;
  while (index < parts.length) {
    const part = parts[index];
    if (part === "--role") {
      role = parts[index + 1];
      if (!role) {
        return null;
      }
      index += 2;
      continue;
    }
    if (part === "--group") {
      groupId = parts[index + 1];
      if (!groupId) {
        return null;
      }
      index += 2;
      continue;
    }
    break;
  }

  const task = rawTail(index);
  if (task.trim().length === 0) {
    return null;
  }

  return {
    kind: "delegate.request",
    targetAgent,
    ...(role ? { role } : {}),
    ...(groupId ? { groupId } : {}),
    task,
  };
}
