import { isKnownXacpxCommandText } from "../commands/command-list";
import { buildCollaborationPrompt, type CollaborationPromptInput } from "./collaboration-prompt";
import type { BotProfile, BotProfileSnapshot } from "./bot-types";

/** `body` is either plain text or the three-layer Group collaboration prompt;
 *  the latter is rendered by buildCollaborationPrompt so its layer order stays
 *  structural. */
export function composeBotTurnPrompt(
  profile: Pick<BotProfile, "name" | "instructions">,
  body: string | CollaborationPromptInput,
  group?: { title?: string; description?: string },
): string {
  // A turn with no assignment carries its request verbatim as evidence, so the
  // whole-input command check still sees exactly what it saw before layers.
  const commandText = typeof body === "string"
    ? body
    : body.evidence.task ? undefined : body.evidence.context;
  if (commandText !== undefined && isKnownXacpxCommandText(commandText)) {
    return commandText;
  }

  const lines = [
    `You are acting as the Bot named "${profile.name}".`,
    profile.instructions ? `Instructions:\n${profile.instructions}` : undefined,
    "This Bot profile does not change the underlying model, tools, or permission policy.",
    groupScopeLine(group),
  ].filter((line): line is string => Boolean(line));

  const content = typeof body === "string" ? body : buildCollaborationPrompt(body);
  if (!content.trim()) {
    return lines.join("\n\n");
  }
  return `${lines.join("\n\n")}\n\n${content}`;
}

export function composeBotTurnPromptFromSnapshot(
  snapshot: BotProfileSnapshot,
  body: string | CollaborationPromptInput,
  group?: { title?: string; description?: string },
): string {
  return composeBotTurnPrompt({
    name: snapshot.presentation.name,
    instructions: snapshot.behavior.instructions,
  }, body, group);
}

/** Group scope header: the Group title/description is presentation, not
 *  execution identity, so callers pass the live record, never a snapshot. */
function groupScopeLine(group: { title?: string; description?: string } | undefined): string | undefined {
  const title = group?.title?.trim();
  const description = group?.description?.trim();
  if (!title && !description) return undefined;
  return [
    "You are collaborating in the Group" + (title ? ` "${title}"` : "") + ".",
    description ? `Group description:\n${description}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}
