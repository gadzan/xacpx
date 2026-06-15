/** Curated catalog of top-level slash commands for the composer's autocomplete.
 *
 *  xacpx is a slash-command-driven console, so surfacing the command surface inline
 *  (à la HAPI's composer suggestion popover) is a large interaction win for the web
 *  dashboard. This is a deliberately STATIC, hand-maintained subset of the most-used
 *  top-level commands; a future enhancement could drive it from a control RPC
 *  (the connector already owns a command-hints catalog) instead of hardcoding. */
export interface CommandEntry {
  name: string; // includes the leading slash, e.g. "/session"
  hint: string; // short one-line description
}

export const COMMAND_CATALOG: CommandEntry[] = [
  { name: "/status", hint: "Show the current session status" },
  { name: "/session", hint: "Manage logical sessions (new/attach/rm/reset/tail)" },
  { name: "/use", hint: "Switch the active session in place" },
  { name: "/agent", hint: "Manage configured agents (add/list/rm)" },
  { name: "/workspace", hint: "Manage configured workspaces" },
  { name: "/permission", hint: "Inspect or set the permission policy" },
  { name: "/later", hint: "Schedule a prompt to run later" },
  { name: "/config", hint: "Inspect or edit configuration" },
  { name: "/ssn", hint: "List/select native acpx sessions" },
  { name: "/reset", hint: "Reset the current session's transport state" },
  { name: "/tail", hint: "Tail recent session output" },
  { name: "/help", hint: "List available commands" },
];

/** Suggestions for the first token of a slash command. Returns [] unless the input is
 *  a single `/word` token (no space yet) — once arguments begin, autocomplete steps
 *  out of the way. An exact, complete match also returns [] (nothing left to suggest). */
export function suggestCommands(input: string): CommandEntry[] {
  if (!input.startsWith("/")) return [];
  if (/\s/.test(input)) return []; // arguments started — stop suggesting
  const q = input.toLowerCase();
  const matches = COMMAND_CATALOG.filter((c) => c.name.toLowerCase().startsWith(q));
  if (matches.length === 1 && matches[0].name.toLowerCase() === q) return [];
  return matches;
}
