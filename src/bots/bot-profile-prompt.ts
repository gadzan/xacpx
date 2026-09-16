import { isKnownXacpxCommandText } from "../commands/command-list";
import type { BotProfile, BotProfileSnapshot } from "./bot-types";

export function composeBotTurnPrompt(
  profile: Pick<BotProfile, "name" | "instructions">,
  userText: string,
): string {
  if (isKnownXacpxCommandText(userText)) {
    return userText;
  }

  const lines = [
    `You are acting as the Bot named "${profile.name}".`,
    profile.instructions ? `Instructions:\n${profile.instructions}` : undefined,
    "This Bot profile does not change the underlying model, tools, or permission policy.",
  ].filter((line): line is string => Boolean(line));

  const body = userText.trim();
  if (!body) {
    return lines.join("\n\n");
  }
  return `${lines.join("\n\n")}\n\n${body}`;
}

export function composeBotTurnPromptFromSnapshot(snapshot: BotProfileSnapshot, userText: string): string {
  return composeBotTurnPrompt({
    name: snapshot.presentation.name,
    instructions: snapshot.behavior.instructions,
  }, userText);
}
