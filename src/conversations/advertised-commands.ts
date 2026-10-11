import type { AgentCommand } from "../transport/types";

export interface AdvertisedCommandIdentity {
  conversationId: string;
  topicId: string;
  botId: string;
}

const commandsByRuntime = new Map<string, AgentCommand[]>();

function runtimeKey(identity: AdvertisedCommandIdentity): string {
  return `${identity.conversationId}\0${identity.topicId}\0${identity.botId}`;
}

export function rememberAdvertisedCommands(identity: AdvertisedCommandIdentity, commands: readonly AgentCommand[]): void {
  commandsByRuntime.set(runtimeKey(identity), commands.map((command) => ({ ...command })));
}

export function clearAdvertisedCommands(): void {
  commandsByRuntime.clear();
  for (const key of epochs.keys()) epochs.set(key, (epochs.get(key) ?? 0) + 1);
}

export function hasAdvertisedCommands(identity: AdvertisedCommandIdentity): boolean { return commandsByRuntime.has(runtimeKey(identity)); }

export function advertisedCommandsFor(identity: AdvertisedCommandIdentity): AgentCommand[] {
  return commandsByRuntime.get(runtimeKey(identity)) ?? [];
}

/** First slash token, without the leading slash. A newline is not a command. */
export function slashToken(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) return null;
  const token = trimmed.split(/\s+/, 1)[0] ?? "";
  if (token.length < 2) return null;
  return token.slice(1).toLowerCase();
}

export function isAdvertisedRuntimeCommand(identity: AdvertisedCommandIdentity, text: string): boolean {
  const name = slashToken(text);
  if (!name) return false;
  return advertisedCommandsFor(identity).some((command) => command.name.toLowerCase() === name);
}

/**
 * The text the adapter must see. An advertised runtime command stays the
 * original user text. Everything else keeps the caller's wrapped prompt.
 */
export function adapterFacingPrompt(identity: AdvertisedCommandIdentity, userText: string, wrapped: string): string {
  return isAdvertisedRuntimeCommand(identity, userText) ? userText : wrapped;
}

/**
 * A slash command is not broadcast. One explicit member may run it.
 * A bare `/token` is refused for every other target. A command with
 * arguments is refused when any targeted runtime has advertised that name.
 */
export function refusesMultiMemberSlash(
  text: string,
  explicitSingleMember: boolean,
  identities: readonly AdvertisedCommandIdentity[],
): boolean {
  if (explicitSingleMember) return false;
  const trimmed = text.trim();
  const name = slashToken(trimmed);
  if (!name) return false;
  const token = trimmed.split(/\s+/, 1)[0] ?? "";
  const bare = trimmed.slice(token.length).trim().length === 0;
  if (bare) return true;
  return identities.some((identity) => isAdvertisedRuntimeCommand(identity, trimmed));
}

const revisions = new Map<string,string>();
const epochs = new Map<string,number>();
export function commandEpoch(identity:AdvertisedCommandIdentity):number{return epochs.get(runtimeKey(identity)) ?? 0;}
export function markCommandRevision(identity:AdvertisedCommandIdentity,revision:string):void {
 const key=runtimeKey(identity);
 if(revisions.get(key)!==revision){revisions.set(key,revision);commandsByRuntime.delete(key);epochs.set(key,(epochs.get(key) ?? 0)+1);}
}

const adapterRevisions = new Map<string, string>();
/** The first observation preserves current advertisements; changes retire their callbacks. */
export function markCommandAdapterRevision(identity: AdvertisedCommandIdentity, revision: string): void {
  const key = runtimeKey(identity);
  const previous = adapterRevisions.get(key);
  if (previous !== undefined && previous !== revision) {
    commandsByRuntime.delete(key);
    epochs.set(key, (epochs.get(key) ?? 0) + 1);
  }
  adapterRevisions.set(key, revision);
}
