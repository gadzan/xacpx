/**
 * Shared composer completion. A menu owns Enter and Tab until it closes.
 * Direct and Group keep their own send, cancel, and recovery outside this module.
 */

export interface TextRange {
  start: number;
  end: number;
}

export interface SlashQuery {
  query: string;
  range: TextRange;
}

export interface MentionQuery {
  query: string;
  range: TextRange;
}

export type CompletionAction =
  | { type: "ignore" }
  | { type: "move"; index: number }
  | { type: "commit"; index: number }
  | { type: "dismiss" }
  | { type: "blocked" }
  | { type: "send" }
  | { type: "cancel" }
  | { type: "history"; dir: -1 | 1 }
  | { type: "passthrough" };

export interface CompletionKeyInput {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  /** True while an IME composition session is open, even if the key event omits isComposing. */
  composing: boolean;
  menu: "closed" | "slash" | "mention";
  itemCount: number;
  activeIndex: number;
  /** An open hint with no rows still owns Enter, Tab, and Escape. */
  holdKeys: boolean;
  /** A non-collapsed selection must not commit a completion. */
  collapsedCaret: boolean;
  busy: boolean;
  caretAtStart: boolean;
  historyArmed: boolean;
}

/** First slash token, only while the caret is inside it. Parameters remain intact. */
export function slashQuery(text: string, cursor = text.length): SlashQuery | null {
  const token = /^\/[^\s]*/.exec(text)?.[0];
  if (!token || cursor < 1 || cursor > token.length) return null;
  return { query: text.slice(1, cursor).toLowerCase(), range: { start: 0, end: token.length } };
}

/**
 * `@` query at the caret. The token is the text from the trigger through the caret.
 * Whitespace ends it. The character before `@` must be a boundary.
 */
export function mentionQueryAt(text: string, cursor: number): MentionQuery | null {
  const pos = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, pos);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s(]/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/[\s\n]/.test(query)) return null;
  return { query: query.toLowerCase(), range: { start: at, end: pos } };
}

export function replaceRange(text: string, range: TextRange, insertion: string): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(range.start, text.length));
  const end = Math.max(start, Math.min(range.end, text.length));
  const next = text.slice(0, start) + insertion + text.slice(end);
  return { text: next, cursor: start + insertion.length };
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

export function completionKey(input: CompletionKeyInput): CompletionAction {
  if (input.isComposing || input.composing) return { type: "ignore" };
  if (input.key === "Enter" && input.shiftKey) return { type: "passthrough" };
  const menuOpen = input.menu !== "closed";
  if (menuOpen && !input.collapsedCaret) {
    if (input.key === "Escape") return { type: "dismiss" };
    if (input.key === "Enter" || input.key === "Tab") return { type: "blocked" };
  }
  if (menuOpen && input.itemCount > 0 && input.collapsedCaret) {
    if (input.key === "ArrowDown") return { type: "move", index: clampIndex(input.activeIndex + 1, input.itemCount) };
    if (input.key === "ArrowUp") return { type: "move", index: clampIndex(input.activeIndex - 1, input.itemCount) };
    if (input.key === "Enter" || input.key === "Tab") return { type: "commit", index: clampIndex(input.activeIndex, input.itemCount) };
    if (input.key === "Escape") return { type: "dismiss" };
  } else if (menuOpen && input.holdKeys) {
    if (input.key === "Enter" || input.key === "Tab") return { type: "blocked" };
    if (input.key === "Escape") return { type: "dismiss" };
  }
  if (input.key === "Escape" && input.busy) return { type: "cancel" };
  if (input.key === "Enter" && !input.shiftKey) return { type: "send" };
  if (input.key === "ArrowUp" && input.caretAtStart) return { type: "history", dir: -1 };
  if (input.key === "ArrowDown" && input.historyArmed && input.caretAtStart) return { type: "history", dir: 1 };
  return { type: "passthrough" };
}

export interface ComposerMention {range:[number,number];handle:string}
/** One contiguous edit: intersected references lose identity; later ones move. */
export function editMentions(previous:string,next:string,mentions:readonly ComposerMention[]):ComposerMention[] {
  let start=0;while(start<previous.length && start<next.length && previous[start]===next[start])start++;
  if(start===previous.length && start===next.length)return mentions.map(m=>({...m,range:[...m.range]}));
  let oldEnd=previous.length,newEnd=next.length;
  while(oldEnd>start && newEnd>start && previous[oldEnd-1]===next[newEnd-1]){oldEnd--;newEnd--;}
  const delta=newEnd-oldEnd;
  return mentions.flatMap(m=>{
    const [a,b]=m.range;
    if(b<=start)return [{...m,range:[a,b] as [number,number]}];
    if(a>=oldEnd)return [{...m,range:[a+delta,b+delta] as [number,number]}];
    return [];
  });
}
