import type { ConversationRunStateDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";

type MemberTurnState = MemberTurnSummaryDto["state"];
type ConversationRunState = ConversationRunStateDto;

/** The translation key for a member turn's state. One mapping for the bubble,
 *  the detail header and the detail body, so the same state never reads as two
 *  different words inside one panel. */
export function memberStateKey(state: MemberTurnState): string {
  switch (state) {
    case "queued":
    case "dispatched": return "bot.run.queued";
    case "running": return "bot.run.running";
    case "completed": return "group.run.memberCompleted";
    case "failed": return "bot.run.failed";
    case "cancelled": return "bot.run.cancelled";
    case "indeterminate": return "bot.run.indeterminate";
  }
}

export function runStateKey(state: ConversationRunState): string {
  switch (state) {
    case "queued": return "bot.run.queued";
    case "running": return "bot.run.running";
    case "waiting-human": return "bot.run.waitingHuman";
    case "completed": return "group.run.memberCompleted";
    case "failed": return "bot.run.failed";
    case "cancelled": return "bot.run.cancelled";
    case "indeterminate": return "bot.run.indeterminate";
  }
}

/** Visual tone of a state pill. The word always carries the meaning; this only
 *  tints it, so a monochrome or high-contrast reader loses nothing. */
export type StateTone = "active" | "done" | "failed" | "waiting" | "idle";

export function memberStateTone(state: MemberTurnState): StateTone {
  switch (state) {
    case "running": return "active";
    case "completed": return "done";
    case "failed": return "failed";
    case "indeterminate": return "waiting";
    case "queued":
    case "dispatched":
    case "cancelled": return "idle";
  }
}

export function runStateTone(state: ConversationRunState): StateTone {
  switch (state) {
    case "running": return "active";
    case "completed": return "done";
    case "failed": return "failed";
    case "waiting-human":
    case "indeterminate": return "waiting";
    case "queued":
    case "cancelled": return "idle";
  }
}
