import { isKnownXacpxCommandText } from "../commands/command-list";
import type { BotProfile, BotProfileSnapshot } from "./bot-types";

export function composeBotTurnPrompt(
  profile: Pick<BotProfile, "name" | "instructions">,
  userText: string,
  group?: { title?: string; description?: string },
): string {
  if (isKnownXacpxCommandText(userText)) {
    return userText;
  }

  const lines = [
    `You are acting as the Bot named "${profile.name}".`,
    profile.instructions ? `Instructions:\n${profile.instructions}` : undefined,
    "This Bot profile does not change the underlying model, tools, or permission policy.",
    groupScopeLine(group),
  ].filter((line): line is string => Boolean(line));

  const body = userText;
  if (!body.trim()) {
    return lines.join("\n\n");
  }
  return `${lines.join("\n\n")}\n\n${body}`;
}

export function composeBotTurnPromptFromSnapshot(
  snapshot: BotProfileSnapshot,
  userText: string,
  group?: { title?: string; description?: string },
): string {
  return composeBotTurnPrompt({
    name: snapshot.presentation.name,
    instructions: snapshot.behavior.instructions,
  }, userText, group);
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
