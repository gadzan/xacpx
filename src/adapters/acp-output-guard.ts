import { fileURLToPath } from "node:url";

export const SAFE_ACP_LINE_CHARS = 2 * 1024 * 1024;
export const TEXT_CHUNK_CHARS = 256 * 1024;
export const MAX_RAW_ACP_LINE_BYTES = 64 * 1024 * 1024;
export const ACP_OUTPUT_GUARD_TRUNCATION_MARKER = "…(truncated by xacpx ACP output guard)";
export const ACP_OUTPUT_GUARD_BINARY_MARKER = "[large binary payload omitted by xacpx ACP output guard]";
export const ACP_OUTPUT_GUARD_ERROR_CODE = "ACPX_OUTPUT_GUARD_FRAME_TOO_LARGE" as const;

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_OBJECT_KEYS = 128;
const DEFAULT_MAX_ARRAY_ITEMS = 64;
const DEFAULT_MAX_STRING_CHARS = 64 * 1024;
const MAX_BOUND_NODES = 100_000;
const DIST_MARKER = "/dist/";

export interface GuardOptions {
  safeSerializedLimit?: number;
  textChunkChars?: number;
  maxDepth?: number;
  maxObjectKeys?: number;
  maxArrayItems?: number;
  maxStringChars?: number;
}

export class AcpOutputGuardError extends Error {
  readonly code = ACP_OUTPUT_GUARD_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AcpOutputGuardError";
  }
}

/**
 * Bounds one complete ACP stdout line before it reaches acpx. Small lines take
 * the exact passthrough path; only oversized lines are parsed and rewritten.
 */
export function guardAcpStdoutLine(line: string, options: GuardOptions = {}): string[] {
  const safeLimit = positiveOption(options.safeSerializedLimit, SAFE_ACP_LINE_CHARS);
  if (line.length <= safeLimit) {
    return [line];
  }

  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    throw new AcpOutputGuardError(
      `non-JSON ACP stdout line exceeded ${safeLimit} characters`,
    );
  }

  if (!isRecord(message)) {
    throw new AcpOutputGuardError(
      `oversized ACP stdout payload is not a JSON-RPC object (${line.length} characters)`,
    );
  }

  const textUpdate = textUpdateParts(message);
  if (textUpdate) {
    const split = splitTextUpdate(message, textUpdate, options, safeLimit);
    if (split) {
      return split;
    }
  }

  const bounded = markQueueTruncation(
    boundJsonValue(message, createBoundContext(options, safeLimit), 0, []),
    message,
    line.length,
  );
  const boundedLine = safeJsonStringify(bounded);
  if (boundedLine !== undefined && boundedLine.length <= safeLimit) {
    return [boundedLine];
  }

  const minimal = minimalAcpMessage(message, line.length);
  const minimalLine = safeJsonStringify(minimal);
  if (minimalLine !== undefined && minimalLine.length <= safeLimit) {
    return [minimalLine];
  }

  throw new AcpOutputGuardError(
    `unable to bound ACP stdout payload below ${safeLimit} characters (${line.length} characters)`,
  );
}

/** Resolve the built guard entry from either a source module or a dist bundle. */
export function resolveAcpOutputGuardEntry(moduleUrl: string = import.meta.url): string {
  if (moduleUrl.endsWith(".ts")) {
    return fileURLToPath(new URL("./acp-output-guard-main.ts", moduleUrl));
  }
  const index = moduleUrl.lastIndexOf(DIST_MARKER);
  if (index !== -1) {
    return fileURLToPath(new URL(
      `${moduleUrl.slice(0, index + DIST_MARKER.length)}adapters/acp-output-guard-main.js`,
      moduleUrl,
    ));
  }
  return fileURLToPath(new URL("./acp-output-guard-main.js", moduleUrl));
}

export function wrapAcpOutputGuardArgv(
  agentArgv: readonly string[],
  execPath: string = process.execPath,
  guardEntry: string = resolveAcpOutputGuardEntry(),
): string[] {
  if (isAcpOutputGuardArgv(agentArgv)) {
    return [...agentArgv];
  }
  return [execPath, guardEntry, "--", ...agentArgv];
}

export function isAcpOutputGuardArgv(argv: readonly string[]): boolean {
  return argv.length >= 3 && argv[2] === "--" && (
    argv[1]?.includes("/acp-output-guard-main.") === true ||
    argv[1]?.includes("\\acp-output-guard-main.") === true
  );
}

type TextUpdateParts = {
  params: Record<string, unknown>;
  update: Record<string, unknown>;
  content: Record<string, unknown>;
  text: string;
};

function textUpdateParts(message: Record<string, unknown>): TextUpdateParts | undefined {
  if (message.method !== "session/update" || !isRecord(message.params)) return undefined;
  const update = message.params.update;
  if (!isRecord(update)) return undefined;
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") {
    return undefined;
  }
  if (!isRecord(update.content) || update.content.type !== "text" || typeof update.content.text !== "string") {
    return undefined;
  }
  return { params: message.params, update, content: update.content, text: update.content.text };
}

function splitTextUpdate(
  message: Record<string, unknown>,
  parts: TextUpdateParts,
  options: GuardOptions,
  safeLimit: number,
): string[] | undefined {
  const skeleton = boundJsonValue(
    {
      ...message,
      params: {
        ...parts.params,
        update: {
          ...parts.update,
          content: { ...parts.content, text: "" },
        },
      },
    },
    createBoundContext(options, safeLimit),
    0,
    [],
  );
  if (!isRecord(skeleton) || !isRecord(skeleton.params) || !isRecord(skeleton.params.update)) {
    return undefined;
  }
  const skeletonUpdate = skeleton.params.update;
  const skeletonContent = isRecord(skeletonUpdate.content) ? skeletonUpdate.content : { type: "text" };
  const textChunkChars = positiveOption(options.textChunkChars, TEXT_CHUNK_CHARS);
  const output: string[] = [];
  let offset = 0;

  while (offset < parts.text.length) {
    let end = safeTextBoundary(parts.text, Math.min(parts.text.length, offset + textChunkChars));
    let accepted: string | undefined;
    while (end > offset) {
      const piece = parts.text.slice(offset, end);
      const candidate = {
        ...skeleton,
        params: {
          ...skeleton.params,
          update: {
            ...skeletonUpdate,
            content: { ...skeletonContent, text: piece },
          },
        },
      };
      const encoded = safeJsonStringify(candidate);
      if (encoded !== undefined && encoded.length <= safeLimit) {
        accepted = encoded;
        break;
      }
      end = safeTextBoundary(parts.text, offset + Math.floor((end - offset) / 2));
    }
    if (accepted === undefined) {
      return undefined;
    }
    output.push(accepted);
    offset = end;
  }

  // Empty text is unusual but can still be oversized because of metadata. It
  // belongs on the generic bounded path rather than silently disappearing.
  if (output.length === 0) return undefined;
  return output;
}

function safeTextBoundary(text: string, proposed: number): number {
  if (proposed <= 0 || proposed >= text.length) return Math.min(text.length, Math.max(0, proposed));
  const code = text.charCodeAt(proposed - 1);
  return code >= 0xd800 && code <= 0xdbff ? proposed - 1 : proposed;
}

type BoundContext = {
  remaining: number;
  nodes: number;
  options: Required<Pick<GuardOptions, "maxDepth" | "maxObjectKeys" | "maxArrayItems" | "maxStringChars">>;
};

function createBoundContext(options: GuardOptions, safeLimit: number): BoundContext {
  return {
    remaining: Math.min(512 * 1024, Math.max(1024, safeLimit - 1024)),
    nodes: 0,
    options: {
      maxDepth: positiveOption(options.maxDepth, DEFAULT_MAX_DEPTH),
      maxObjectKeys: positiveOption(options.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS),
      maxArrayItems: positiveOption(options.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS),
      maxStringChars: positiveOption(options.maxStringChars, DEFAULT_MAX_STRING_CHARS),
    },
  };
}

function boundJsonValue(value: unknown, context: BoundContext, depth: number, path: string[]): unknown {
  context.nodes += 1;
  if (context.nodes > MAX_BOUND_NODES || context.remaining <= 0) {
    return ACP_OUTPUT_GUARD_TRUNCATION_MARKER;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    context.remaining -= 16;
    return value;
  }
  if (typeof value === "string") {
    return boundString(value, context, path.at(-1));
  }
  if (depth >= context.options.maxDepth) {
    context.remaining -= ACP_OUTPUT_GUARD_TRUNCATION_MARKER.length;
    return ACP_OUTPUT_GUARD_TRUNCATION_MARKER;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value.slice(0, context.options.maxArrayItems)) {
      result.push(boundJsonValue(item, context, depth + 1, [...path, "[]"]));
      if (context.remaining <= 0) break;
    }
    if (value.length > result.length && context.remaining > 0) {
      result.push(ACP_OUTPUT_GUARD_TRUNCATION_MARKER);
    }
    context.remaining -= 2;
    return result;
  }
  if (!isRecord(value)) {
    return ACP_OUTPUT_GUARD_TRUNCATION_MARKER;
  }
  const result: Record<string, unknown> = {};
  const keys = prioritizedKeys(Object.keys(value), path.at(-1));
  for (const key of keys.slice(0, context.options.maxObjectKeys)) {
    if (context.remaining <= 0) break;
    result[key] = boundJsonValue(value[key], context, depth + 1, [...path, key]);
  }
  if (keys.length > Object.keys(result).length && context.remaining > 0) {
    result.__xacpxTruncated = true;
  }
  context.remaining -= 2;
  return result;
}

function boundString(value: string, context: BoundContext, key: string | undefined): string {
  if (value.length <= context.options.maxStringChars) {
    context.remaining -= value.length;
    return value;
  }
  if (key?.toLowerCase() === "data" && looksBinaryLike(value)) {
    context.remaining -= ACP_OUTPUT_GUARD_BINARY_MARKER.length;
    return ACP_OUTPUT_GUARD_BINARY_MARKER;
  }
  const cap = Math.max(32, Math.min(context.options.maxStringChars, Math.max(32, context.remaining - 64)));
  const marker = ACP_OUTPUT_GUARD_TRUNCATION_MARKER;
  const lowerKey = key?.toLowerCase();
  let result: string;
  if (lowerKey === "stdout" || lowerKey === "stderr" || lowerKey?.includes("diff")) {
    const available = Math.max(0, cap - marker.length);
    const head = Math.min(16 * 1024, Math.floor(available / 2));
    result = `${value.slice(0, head)}${marker}${value.slice(-Math.max(0, available - head))}`;
  } else {
    result = `${value.slice(0, Math.max(0, cap - marker.length))}${marker}`;
  }
  context.remaining -= result.length;
  return result;
}

function prioritizedKeys(keys: string[], parentKey: string | undefined): string[] {
  if (parentKey !== "_meta") return keys;
  const preferred = ["qoder", "codex", "claudeCode", "routing", "toolName", "parentToolUseId"];
  return [...keys].sort((left, right) => {
    const leftIndex = preferred.indexOf(left);
    const rightIndex = preferred.indexOf(right);
    return (leftIndex === -1 ? preferred.length : leftIndex) - (rightIndex === -1 ? preferred.length : rightIndex);
  });
}

function markQueueTruncation(
  bounded: unknown,
  original: Record<string, unknown>,
  originalSerializedLength: number,
): unknown {
  if (!isRecord(bounded) || original.method !== "session/update" || !isRecord(bounded.params)) {
    return bounded;
  }
  const boundedUpdate = isRecord(bounded.params.update) ? bounded.params.update : {};
  const originalUpdate = isRecord(original.params) && isRecord(original.params.update)
    ? original.params.update
    : {};
  return {
    ...bounded,
    params: {
      ...bounded.params,
      update: {
        ...boundedUpdate,
        _meta: {
          ...(isRecord(boundedUpdate._meta) ? boundedUpdate._meta : {}),
          acpx: {
            ...(isRecord(boundedUpdate._meta) && isRecord(boundedUpdate._meta.acpx) ? boundedUpdate._meta.acpx : {}),
            queueTruncated: true,
            originalSerializedLength,
          },
        },
        ...(originalUpdate.sessionUpdate ? { sessionUpdate: boundedUpdate.sessionUpdate ?? originalUpdate.sessionUpdate } : {}),
      },
    },
  };
}

function minimalAcpMessage(message: Record<string, unknown>, originalSerializedLength: number): Record<string, unknown> {
  const minimal: Record<string, unknown> = {};
  for (const key of ["jsonrpc", "id", "method"]) {
    if (key in message) minimal[key] = message[key];
  }
  if (message.method === "session/update" && isRecord(message.params)) {
    const update = isRecord(message.params.update) ? message.params.update : {};
    const minimalUpdate: Record<string, unknown> = {
      sessionUpdate: typeof update.sessionUpdate === "string" ? update.sessionUpdate : "unknown",
    };
    for (const key of ["toolCallId", "parentToolCallId", "status", "kind", "title", "locations", "messageId"]) {
      if (key in update) minimalUpdate[key] = key === "locations"
        ? boundJsonValue(update[key], createBoundContext({}, SAFE_ACP_LINE_CHARS), 0, [key])
        : update[key];
    }
    minimalUpdate.content = { type: "text", text: ACP_OUTPUT_GUARD_TRUNCATION_MARKER };
    minimalUpdate._meta = { acpx: { queueTruncated: true, originalSerializedLength } };
    minimal.params = {
      ...(typeof message.params.sessionId === "string" ? { sessionId: message.params.sessionId } : {}),
      update: minimalUpdate,
    };
  } else if ("id" in message) {
    minimal.result = {};
  } else if ("params" in message) {
    minimal.params = { _meta: { acpx: { queueTruncated: true, originalSerializedLength } } };
  }
  return minimal;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function looksBinaryLike(value: string): boolean {
  return value.length > 4096 && /^[A-Za-z0-9+/=\s]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveOption(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
