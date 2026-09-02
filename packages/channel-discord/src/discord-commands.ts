export interface DiscordSlashCommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  choices?: Array<{ name: string; value: string }>;
}

export interface DiscordSlashCommand {
  name: string;
  description: string;
  options?: DiscordSlashCommandOption[];
}

/**
 * Build the xacpx slash command catalog that is registered as Discord
 * Application Commands for autocomplete. Names mirror `src/commands/parse-command.ts`
 * aliases so Discord's `/` hints directly map to the text-command router.
 */
export function buildXacpxSlashCommands(): DiscordSlashCommand[] {
  return [
    { name: "help", description: "Show xacpx help and available commands" },
    {
      name: "ss",
      description: "Session shortcut: create or reuse a session",
      options: [
        { name: "agent", description: "agent id (e.g. codex, claude)", type: 3, required: true },
        { name: "workspace", description: "workspace path or name", type: 3 },
        { name: "new", description: "force new session even if one exists", type: 5 },
      ],
    },
    { name: "use", description: "Switch to a session", options: [{ name: "alias", description: "session alias", type: 3, required: true }] },
    { name: "cancel", description: "Cancel current or named session", options: [{ name: "alias", description: "session alias to cancel", type: 3 }] },
    { name: "status", description: "Show current session status" },
    { name: "sessions", description: "List sessions" },
  ];
}

export interface RegisterDiscordCommandsOptions {
  token: string;
  applicationId: string;
  guildId?: string;
  commands: DiscordSlashCommand[];
  restImpl?: unknown;
}

/**
 * Register the slash command catalog via Discord REST.
 * Best-effort: callers log and swallow failures; a failed registration must not
 * prevent the Gateway session from starting.
 */
export async function registerDiscordCommands(options: RegisterDiscordCommandsOptions): Promise<void> {
  const { token, applicationId, guildId, commands } = options;
  if (!token || !applicationId) throw new Error("registerDiscordCommands requires token and applicationId");
  const restCtor = options.restImpl as new (opts: unknown) => { setToken: (t: string) => unknown };
  let REST: new (opts: unknown) => { setToken: (t: string) => unknown; put: (route: string, opts: unknown) => Promise<unknown> };
  let Routes: { applicationCommands: (appId: string) => string; applicationGuildCommands: (appId: string, guildId: string) => string };
  if (restCtor) {
    REST = restCtor as unknown as typeof REST;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Routes = (options as unknown as { Routes?: typeof Routes }).Routes ?? (await import("discord.js") as unknown as { Routes: typeof Routes }).Routes;
  } else {
    const discord = (await import("discord.js")) as unknown as {
      REST: typeof REST;
      Routes: typeof Routes;
    };
    REST = discord.REST;
    Routes = discord.Routes;
  }
  const rest = new REST({ version: "10" }).setToken(token) as unknown as { put: (route: string, opts: unknown) => Promise<unknown> };
  const route = guildId ? Routes.applicationGuildCommands(applicationId, guildId) : Routes.applicationCommands(applicationId);
  await rest.put(route, { body: commands });
}
