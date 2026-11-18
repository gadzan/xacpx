import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseCommand } from "../../../src/commands/parse-command";
import { XACPX_KNOWN_COMMAND_PREFIXES, isKnownXacpxCommandText } from "../../../src/commands/command-list";

const ROOT = join(import.meta.dir, "../../..");

/**
 * `/model` shipped in 600a849a (2026-06-15) updating parse-command,
 * command-router, command-policy, help-registry and the i18n messages — but not
 * this prefix list, so `isKnownXacpxCommandText("/model …")` answered false.
 * The parser handles the command explicitly, so ordinary sessions kept working
 * and nothing noticed; the two consumers that gate on the registry did not:
 *
 *  - channels/conversation-channel-router.ts returns `undefined` (hand the text
 *    back to the Session/command router) only for a *known* command, so on a
 *    chat bound to a durable Conversation Run `/model <id>` was swallowed into
 *    the Conversation as ordinary prompt text;
 *  - bots/bot-profile-prompt.ts passes the turn text through verbatim only for
 *    a known command, so a Bot whose prompt starts with `/model` had it wrapped
 *    into the collaboration preamble instead of executed.
 *
 * These tests pin the invariant both ways so the next omission fails here
 * rather than in production.
 */

/** Canonical command words the parser dispatches on (`command === "/x"`). */
function parserCommands(): string[] {
  const source = readFileSync(join(ROOT, "src/commands/parse-command.ts"), "utf8");
  return [...new Set([...source.matchAll(/command === "(\/[a-z]+)"/g)].map((m) => m[1]!))].sort();
}

/** Aliases normalizeCommand() folds onto a canonical word before dispatch. */
const ALIASES: Record<string, string> = {
  "/ss": "/session",
  "/ws": "/workspace",
  "/pm": "/permission",
  "/stop": "/cancel",
  "/lt": "/later",
};

test("registry: every command the parser dispatches is a known prefix", () => {
  const registered = new Set<string>(XACPX_KNOWN_COMMAND_PREFIXES);
  const missing = parserCommands().filter((command) => !registered.has(command));
  expect(missing).toEqual([]);
});

test("registry: every known prefix is dispatched or is an alias of one", () => {
  const dispatched = new Set(parserCommands());
  const aliasSpellings = new Set(Object.keys(ALIASES));
  const dead = XACPX_KNOWN_COMMAND_PREFIXES.filter(
    (prefix) => !dispatched.has(prefix) && !aliasSpellings.has(prefix),
  );
  expect(dead).toEqual([]);
});

test("registry: aliases resolve to a registered canonical prefix", () => {
  const registered = new Set<string>(XACPX_KNOWN_COMMAND_PREFIXES);
  for (const [alias, target] of Object.entries(ALIASES)) {
    expect(registered.has(alias)).toBe(true);
    expect(registered.has(target)).toBe(true);
  }
});

test("/model is recognized as a command by the registry consumers", () => {
  // The two behaviors that were broken, asserted at the consumer boundary.
  expect(isKnownXacpxCommandText("/model")).toBe(true);
  expect(isKnownXacpxCommandText("/model gpt-5.2[high]")).toBe(true);
  // The parser still owns the actual semantics.
  expect(parseCommand("/model")).toEqual({ kind: "model.show" });
  expect(parseCommand("/model gpt-5.2[high]")).toEqual({
    kind: "model.set",
    modelId: "gpt-5.2[high]",
  });
});

test("an unregistered slash word is still a prompt, not a command", () => {
  expect(isKnownXacpxCommandText("/modelx")).toBe(false);
  expect(isKnownXacpxCommandText("model gpt-5.2")).toBe(false);
  expect(parseCommand("/modelx gpt-5.2")).toEqual({ kind: "prompt", text: "/modelx gpt-5.2" });
});
