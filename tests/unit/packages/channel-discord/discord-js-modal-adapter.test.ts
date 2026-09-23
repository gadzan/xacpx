/**
 * Adapter-level coverage for the discord.js interaction bridge.
 *
 * These exercise `DiscordJsClient.start()`'s interactionCreate dispatch with
 * shapes taken from the installed discord.js typings, NOT the normalized
 * interaction the channel hands the renderer. The renderer tests fake the
 * normalized layer; this file is what catches a mismatch between what we SEND
 * to Discord and what Discord/discord.js actually delivers back — which is how
 * the modal field extraction lost every real answer.
 */

import { describe, expect, test } from "bun:test";
import { DiscordJsClient } from "../../../../packages/channel-discord/src/discord-client";
import type {
  DiscordButtonInteraction,
  DiscordModalSubmitInteraction,
  DiscordSelectInteraction,
} from "../../../../packages/channel-discord/src/types";

interface FakeGatewayClient {
  on(event: string, handler: (interaction: unknown) => void): void;
  login(token: string): Promise<string>;
  destroy(): void;
  user: { id: string; tag?: string };
}

function makeGatewayClient(): FakeGatewayClient & {
  interactionHandler?: (interaction: unknown) => void;
} {
  const client = {
    interactionHandler: undefined as ((interaction: unknown) => void) | undefined,
    on(event: string, handler: (interaction: unknown) => void): void {
      if (event === "interactionCreate") client.interactionHandler = handler;
    },
    async login(): Promise<string> {
      return "token";
    },
    destroy(): void {},
    user: { id: "bot-1", tag: "bot#0001" },
  };
  return client;
}

/** Build a client whose Gateway is the fake, and wait for it to be listening. */
async function startWithGateway(
  gateway: FakeGatewayClient,
  onModalSubmit: (i: DiscordModalSubmitInteraction) => void,
  extraHandlers: Partial<{
    onButton: (i: DiscordButtonInteraction) => void;
    onSelect: (i: DiscordSelectInteraction) => void;
  }> = {},
): Promise<void> {
  const client = new DiscordJsClient({
    token: "t",
    intentsMessageContent: false,
    intentsGuildMembers: false,
    createGateway: () => gateway,
  } as never);
  await client.start({
    handlers: { onMessage: () => {}, onModalSubmit: onModalSubmit, ...extraHandlers },
    abortSignal: new AbortController().signal,
  });
}

/** A modal submit shaped exactly like discord.js delivers it. */
function discordJsModalSubmit(): unknown {
  const entries = new Map<string, { type: number; custom_id: string; value: string }>([
    ["f:0", { type: 4, custom_id: "f:0", value: "ship it" }],
  ]);
  return {
    customId: `xacpx-elicit:${"a".repeat(32)}:modal`,
    isModalSubmit: (): boolean => true,
    isButton: (): boolean => false,
    isStringSelectMenu: (): boolean => false,
    channelId: "c1",
    guildId: "g1",
    user: { id: "user-A" },
    // `ModalSubmit fields` is a Collection<customId, component>. The components
    // we OPENED the modal with are Label (type 18) wrappers, and their value
    // lives on the child input at `component`, never at `row.components`.
    fields: {
      fields: entries,
      getTextInputValue: (id: string): string => entries.get(id)?.value ?? "",
    },
    replied: false,
    deferred: false,
    reply: async (): Promise<void> => {},
  };
}

describe("discord.js modal adapter", () => {
  test("a Label-wrapped Text Input's value reaches the normalized interaction", async () => {
    const gateway = makeGatewayClient();
    const seen: DiscordModalSubmitInteraction[] = [];
    await startWithGateway(gateway, (i) => seen.push(i));
    gateway.interactionHandler!(discordJsModalSubmit());
    expect(seen).toHaveLength(1);
    // The answer was NOT silently discarded, and the id is POSITIONAL, not the
    // schema key: core allows a 128-char key and Discord caps component ids at
    // 100.
    expect(seen[0]!.fields).toEqual({ "f:0": "ship it" });
    expect(seen[0]!.userId).toBe("user-A");
    expect(seen[0]!.customId.startsWith("xacpx-elicit:")).toBe(true);
  });

  test("a Map-only field collection (no getTextInputValue) still resolves", async () => {
    const gateway = makeGatewayClient();
    const seen: DiscordModalSubmitInteraction[] = [];
    await startWithGateway(gateway, (i) => seen.push(i));
    const payload = discordJsModalSubmit() as { fields: { getTextInputValue?: unknown } };
    delete payload.fields.getTextInputValue;
    gateway.interactionHandler!(payload);
    expect(seen[0]!.fields).toEqual({ "f:0": "ship it" });
  });

  test("an empty modal submit produces an empty map, not a throw", async () => {
    const gateway = makeGatewayClient();
    const seen: DiscordModalSubmitInteraction[] = [];
    await startWithGateway(gateway, (i) => seen.push(i));
    const payload = discordJsModalSubmit() as { fields: { fields: unknown } };
    payload.fields.fields = new Map();
    gateway.interactionHandler!(payload);
    expect(seen[0]!.fields).toEqual({});
  });

  test("a non-elicitation modal is dropped without a handler call", async () => {
    const gateway = makeGatewayClient();
    const seen: DiscordModalSubmitInteraction[] = [];
    const buttons: DiscordButtonInteraction[] = [];
    const selects: DiscordSelectInteraction[] = [];
    await startWithGateway(gateway, (i) => seen.push(i), {
      onButton: (i) => buttons.push(i),
      onSelect: (i) => selects.push(i),
    });
    const payload = discordJsModalSubmit() as { customId: string };
    payload.customId = "some-other-feature:modal";
    gateway.interactionHandler!(payload);
    expect(seen).toHaveLength(0);
    expect(buttons).toHaveLength(0);
    expect(selects).toHaveLength(0);
  });
});
