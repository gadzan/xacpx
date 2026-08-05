import { readFile } from "node:fs/promises";

import { writePrivateFileAtomic } from "../util/private-file.js";

import { serializeRawConfig } from "./config-store";
import { DEFAULT_HOME_WORKSPACE, DEFAULT_HOME_WORKSPACE_NAME } from "./default-workspace";
import { loadConfig, parseConfig } from "./load-config";
import { resolveAgentCommand } from "./resolve-agent-command";

interface EnsureConfigOptions {
  readDefaultConfigTemplate?: () => Promise<unknown>;
}

const BUILTIN_DEFAULT_CONFIG_TEMPLATE = {
  transport: {
    type: "acpx-bridge",
  },
  channel: {
    type: "weixin",
    replyMode: "verbose",
  },
  agents: {
    codex: { driver: "codex" },
    claude: { driver: "claude" },
  },
  workspaces: {
    [DEFAULT_HOME_WORKSPACE_NAME]: { ...DEFAULT_HOME_WORKSPACE },
  },
} satisfies unknown;

export async function ensureConfigExists(path: string, options: EnsureConfigOptions = {}): Promise<void> {
  try {
    await loadConfig(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    const seed = await loadDefaultConfigTemplate(options);
    await writePrivateFileAtomic(path, serializeRawConfig(seed));
  }
}

async function loadDefaultConfigTemplate(options: EnsureConfigOptions = {}): Promise<Record<string, unknown>> {
  if (options.readDefaultConfigTemplate) {
    try {
      return normalizeDefaultConfigTemplate(await options.readDefaultConfigTemplate());
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  const candidates = [
    new URL("../../config.example.json", import.meta.url),
    new URL("../config.example.json", import.meta.url),
  ];

  let raw: string | undefined;
  for (const candidate of candidates) {
    try {
      raw = await readFile(candidate, "utf8");
      break;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  if (!raw) {
    return normalizeDefaultConfigTemplate(BUILTIN_DEFAULT_CONFIG_TEMPLATE);
  }

  return normalizeDefaultConfigTemplate(JSON.parse(raw) as unknown);
}

/**
 * Builds the raw seed object written on first run. The template is validated
 * through the shared parser, but the seed deliberately contains only what a
 * working starter file needs: defaults the loader materializes anyway
 * (timeouts, permission modes, logging limits, TTLs) are NOT pinned, so future
 * default changes reach existing installs.
 */
export function normalizeDefaultConfigTemplate(raw: unknown): Record<string, unknown> {
  const template = parseConfig(raw);

  return {
    transport: {
      type: template.transport.type,
      ...(template.transport.command ? { command: template.transport.command } : {}),
    },
    channel: {
      type: template.channel.type,
      replyMode: template.channel.replyMode,
    },
    agents: Object.fromEntries(
      Object.entries(template.agents).map(([name, agent]) => [
        name,
        {
          driver: agent.driver,
          ...(resolveAgentCommand(agent.driver, agent.command)
            ? { command: resolveAgentCommand(agent.driver, agent.command) }
            : {}),
          ...(agent.argv ? { argv: [...agent.argv] } : {}),
        },
      ]),
    ),
    // Seed exactly one usable workspace (home) regardless of what the template
    // file carries, so the written config is deterministic. `~` is kept literal
    // here and expanded to the real home dir when the config is later loaded.
    workspaces: {
      [DEFAULT_HOME_WORKSPACE_NAME]: { ...DEFAULT_HOME_WORKSPACE },
    },
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
