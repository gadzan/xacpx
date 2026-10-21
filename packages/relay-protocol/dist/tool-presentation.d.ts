import type { ToolStepDto } from "./dtos.js";
/** Structural public tool input; accepts Core events without a plugin dependency. */
export interface PublicToolUseEvent {
    toolCallId: string;
    parentToolCallId?: string;
    isSubagent?: boolean;
    toolName: string;
    machineToolName?: string;
    kind: ToolStepDto["kind"];
    summary?: string;
    rawInput?: unknown;
    content?: unknown;
    rawOutput?: unknown;
    locations?: unknown;
    status: ToolStepDto["status"];
    durationMs?: number;
    startedAt?: number;
}
/** Truncation markers. `cap` appends a suffix marker and `capTail` a prefix one;
 *  the web's error-banner de-duplication and diff-stat guards must recognise BOTH,
 *  so both strings live here and are mirrored in the web's ToolStepCard. */
export declare const TRUNCATED_SUFFIX_MARK = "\n\u2026(truncated)";
export declare const TRUNCATED_PREFIX_MARK = "(truncated)\u2026\n";
/** Normalize a raw core ToolUseEvent into a friendly, capped, presentation-ready step. */
export declare function toolUseEventToStepDto(event: PublicToolUseEvent): ToolStepDto;
