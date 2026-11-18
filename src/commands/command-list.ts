export const XACPX_KNOWN_COMMAND_PREFIXES = [
  "/help",
  "/agents",
  "/workspaces",
  "/sessions",
  "/tasks",
  "/status",
  "/cancel",
  "/stop",
  "/clear",
  "/model",
  "/mode",
  "/replymode",
  "/config",
  "/permission",
  "/pm",
  "/session",
  "/ss",
  "/ssn",
  "/workspace",
  "/ws",
  "/use",
  "/agent",
  "/delegate",
  "/dg",
  "/group",
  "/groups",
  "/task",
  "/later",
  "/lt",
] as const;

const KNOWN_COMMAND_PREFIX_SET = new Set<string>(XACPX_KNOWN_COMMAND_PREFIXES);

export function isKnownXacpxCommandPrefix(prefix: string): boolean {
  return KNOWN_COMMAND_PREFIX_SET.has(prefix.toLowerCase());
}

export function isKnownXacpxCommandText(text: string): boolean {
  const firstToken = text.trim().split(/\s+/, 1)[0];
  return Boolean(firstToken && isKnownXacpxCommandPrefix(firstToken));
}
