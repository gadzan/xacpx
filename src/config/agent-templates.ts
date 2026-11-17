import type { AgentConfig } from "./types";

const TEMPLATES: Record<string, AgentConfig> = {
  codex: {
    driver: "codex",
  },
  claude: {
    driver: "claude",
  },
  // acpx 0.22.0 experimental builtin (`ante acp`, needs the separate `ante-acp`
  // adapter; acpx does not reopen its sessions after a disconnect).
  ante: {
    driver: "ante",
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
  // acpx 0.22.0 builtin: command-free so the default command comes from acpx's own
  // registry (`dsh --profile acp`), never duplicated here.
  "deepseek-harness": {
    driver: "deepseek-harness",
  },
  "factory-droid": {
    driver: "factory-droid",
  },
  factorydroid: {
    driver: "factorydroid",
  },
  // acpx 0.22.0 builtin: command-free so the default command comes from acpx's own
  // registry (`goose acp`), never duplicated here.
  goose: {
    driver: "goose",
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
  // acpx 0.15 builtin: command-free so the default command comes from acpx's own
  // registry (`mcode acp`), never duplicated here.
  mcode: {
    driver: "mcode",
  },
  mux: {
    driver: "mux",
  },
  // acpx 0.20.0 builtin: command-free so the default command comes from acpx's own
  // registry (`octomind acp developer:general`), never duplicated here.
  octomind: {
    driver: "octomind",
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
