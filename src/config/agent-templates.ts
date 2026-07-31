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
  // Not in acpx's builtin registry; the explicit command makes acpx spawn it raw.
  hermes: {
    driver: "hermes",
    command: "hermes acp",
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
  opencode: {
    driver: "opencode",
  },
  qoder: {
    driver: "qoder",
  },
  qwen: {
    driver: "qwen",
  },
  trae: {
    driver: "trae",
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
