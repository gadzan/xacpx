import { isKnownXacpxCommandText } from "../commands/command-list";
import type { BotProfile } from "./bot-types";

export function composeBotTurnPrompt(profile: BotProfile, userText: string): string {
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
