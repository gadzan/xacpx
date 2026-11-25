export interface PromptCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class PromptCommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, result: PromptCommandResult) {
    super(message);
    this.name = "PromptCommandError";
    this.exitCode = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

interface ExtractedPromptOutput {
  text: string;
  hasAgentMessage: boolean;
}

export function getPromptText(result: PromptCommandResult): string {
  const stdoutOutput = extractPromptOutput(result.stdout);
  if (result.code === 0) {
    return sanitizePromptText(stdoutOutput.text);
  }

  const preferredError = extractPromptFailureMessage(result);
  if (preferredError) {
    throw new PromptCommandError(preferredError, result);
  }

  const stderrOutput = extractPromptOutput(result.stderr);
  const partialReply = [stdoutOutput, stderrOutput]
    .filter((output) => output.hasAgentMessage && output.text.length > 0)
    .map((output) => sanitizePromptText(output.text))
    .find((text) => text.length > 0);

  if (partialReply) {
    return partialReply;
  }

  throw new PromptCommandError(`command failed with exit code ${result.code}`, result);
}

export function normalizeCommandError(result: Pick<PromptCommandResult, "stdout" | "stderr">): string | null {
  const preferredError = extractPromptFailureMessage(result);
  if (preferredError) {
    return preferredError;
  }

  return result.stdout.trim() || null;
}

function extractPromptFailureMessage(result: Pick<PromptCommandResult, "stdout" | "stderr">): string | null {
  const rpcMessages = extractJsonRpcErrorMessages(result.stderr)
    .concat(extractJsonRpcErrorMessages(result.stdout))
    .filter((message) => message.length > 0);

  const preferredMessage = [...rpcMessages].reverse().find((message) => message !== "Resource not found");
  if (preferredMessage) {
    return preferredMessage;
  }

  if (rpcMessages.length > 0) {
    return rpcMessages[rpcMessages.length - 1] ?? null;
  }

  const stderrText = result.stderr.trim();
  if (stderrText.length > 0) {
    return stderrText;
  }

  return null;
}

function extractPromptOutput(output: string): ExtractedPromptOutput {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Concatenate every agent_message_chunk into the full reply. Interleaved
  // events (tool calls, thoughts, mode updates) and non-JSON noise lines are
  // ignored — they must not split the message, otherwise a tool call
  // mid-answer drops everything but the trailing fragment.
  let text = "";
  let hasAgentMessage = false;

  for (const line of lines) {
    let event: {
      method?: string;
      params?: {
        update?: {
          sessionUpdate?: string;
          content?: {
            type?: string;
            text?: string;
          };
        };
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const isMessageChunk =
      event.method === "session/update" &&
      event.params?.update?.sessionUpdate === "agent_message_chunk" &&
      event.params.update.content?.type === "text" &&
      typeof event.params.update.content.text === "string";

    if (isMessageChunk) {
      hasAgentMessage = true;
      text += event.params!.update!.content!.text ?? "";
    }
  }

  if (hasAgentMessage && text.trim().length > 0) {
    return {
      text: text.trim(),
      hasAgentMessage,
    };
  }

  return {
    text: output.trim(),
    hasAgentMessage,
  };
}

function sanitizePromptText(text: string): string {
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n\s*\n/);
  if (paragraphs.length < 2) {
    return trimmed;
  }

  const firstParagraph = paragraphs[0]!.trim().replace(/\s+/g, " ").toLowerCase();
  if (!looksLikeWorkflowPreamble(firstParagraph)) {
    return trimmed;
  }

  return paragraphs.slice(1).join("\n\n").trim();
}

function looksLikeWorkflowPreamble(paragraph: string): boolean {
  if (!paragraph.startsWith("using ")) {
    return false;
  }

  return (
    paragraph.includes("using-superpowers") ||
    paragraph.includes("repo workflow requirement") ||
    paragraph.includes("workflow requirement") ||
    paragraph.includes("before responding") ||
    paragraph.includes("skill check")
  );
}

function extractJsonRpcErrorMessages(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const payload = JSON.parse(line) as {
          error?: {
            message?: string;
            data?: { message?: string; details?: string };
          };
        };

        const err = payload.error;
        // ACP servers disagree on where the specific reason lives. `data.message`
        // is the ACP-typed field; `data.details` is what omp sends, and it is
        // usually the only place the real cause appears — the outer `message` is
        // a generic "Internal error". Reading only `data.message` surfaced
        // "Internal error" while "ACP session not found: <id>" sat one field
        // away. Accept either, preferring whichever says more than the base.
        const dataMsg = firstNonEmpty(err?.data?.message, err?.data?.details);
        const baseMsg = typeof err?.message === "string" && err.message.length > 0
          ? err.message
          : undefined;

        // Prefer the data payload when it's more specific than error.message
        const chosen = dataMsg && dataMsg !== baseMsg ? dataMsg : baseMsg;
        if (chosen) {
          return [chosen];
        }
      } catch {
        return [];
      }

      return [];
    });
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
