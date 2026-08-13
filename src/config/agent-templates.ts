import type { AgentConfig } from "./types";

const TEMPLATES: Record<string, AgentConfig> = {
  codex: {
    driver: "codex",
  },
  claude: {
    driver: "claude",
  },
  pi: {
    driver: "pi",
  },
  openclaw: {
    driver: "openclaw",
  },
  gemini: {
    driver: "gemini",
  },
  cursor: {
    driver: "cursor",
  },
  copilot: {
    driver: "copilot",
  },
  droid: {
    driver: "droid",
  },
  "factory-droid": {
    driver: "factory-droid",
  },
  factorydroid: {
    driver: "factorydroid",
  },
  "grok-build": {
    driver: "grok-build",
  },
  // Not an acpx builtin: resolveRuntimeAgentCommand supplies the ACP shim command
  // at spawn time (see src/adapters/hermes-shim.ts), so no command is persisted.
  hermes: {
    driver: "hermes",
  },
  iflow: {
    driver: "iflow",
  },
  kilocode: {
    driver: "kilocode",
  },
  kimi: {
    driver: "kimi",
  },
  kiro: {
    driver: "kiro",
  },
  mux: {
    driver: "mux",
  },
  // Local-fallback templates: acpx's registry doesn't know these drivers, but
  // their native CLIs (`omp` from `@oh-my-pi/cli`, `opencode`) speak ACP via
  // `<bin> acp`. See LOCAL_AGENT_BINS in local-agent-bin.ts and the drift-guard
  // exemption in agent-catalog.test.ts.
  omp: {
    driver: "omp",
  },
  opencode: {
    driver: "opencode",
  },
  // acpx 0.13 builtin: command-free so the default command comes from acpx's own
  // registry (`pool acp`), never duplicated here.
  pool: {
    driver: "pool",
  },
  qoder: {
    driver: "qoder",
  },
  qwen: {
    driver: "qwen",
  },
  // Local-fallback template: same shape as omp/opencode — acpx doesn't list it,
  // but `reasonix` (npm `reasonix`) exposes ACP via `reasonix acp`.
  reasonix: {
    driver: "reasonix",
  },
  trae: {
    driver: "trae",
  },
  // acpx 0.13 builtin: command-free so the default command comes from acpx's own
  // registry (`zeroclaw acp`), never duplicated here.
  zeroclaw: {
    driver: "zeroclaw",
  },
};

export function getAgentTemplate(name: string): AgentConfig | null {
  const template = TEMPLATES[name];
  if (!template) {
    return null;
  }

  return {
    ...template,
  };
}

export function listAgentTemplates(): string[] {
  return Object.keys(TEMPLATES);
}

export function sameAgentConfig(left: AgentConfig, right: AgentConfig): boolean {
  return left.driver === right.driver && (left.command ?? "") === (right.command ?? "");
}
