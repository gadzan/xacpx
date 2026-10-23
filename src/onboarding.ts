import { basenameForWorkspacePath, normalizeWorkspacePath } from "./commands/workspace-path.js";
import { allocateWorkspaceName, sanitizeWorkspaceName } from "./commands/workspace-name.js";
import { DEFAULT_HOME_WORKSPACE_NAME } from "./config/default-workspace.js";
import type { AgentConfig, AppConfig } from "./config/types.js";
import type { AppState } from "./state/types.js";
import { listAgentTemplates, getAgentTemplate } from "./config/agent-templates.js";
import { t } from "./i18n/index.js";

export interface OnboardingDeps {
  cwd: () => string;
  print: (line: string) => void;
  isInteractive: () => boolean;
  promptText: (message: string) => Promise<string>;
}

export interface FirstRunOnboardingPlan {
  alias: string;
  agent: string;
  workspace: string;
  /**
   * Normalized cwd the onboarding registered for `workspace`. Optional so a
   * plan decoded from an older daemon-start payload (encoded before this
   * field existed) still decodes: rollback then falls back to name-only
   * removal, as it did before.
   */
  workspaceCwd?: string;
  rollback: {
    workspaceExisted: boolean;
    agentExisted: boolean;
  };
}

export type OnboardingResult =
  | ({ created: true } & FirstRunOnboardingPlan)
  | { created: false };

export function isFirstUse(config: Pick<AppConfig, "workspaces" | "plugins">, state: Pick<AppState, "sessions">): boolean {
  // A config carrying only the seeded `home` workspace is still "first use":
  // the seed gives users something usable, but it shouldn't suppress the
  // interactive onboarding (add current dir + initial session).
  const workspaceNames = Object.keys(config.workspaces ?? {});
  const onlyDefaultOrEmpty =
    workspaceNames.length === 0 ||
    (workspaceNames.length === 1 && workspaceNames[0] === DEFAULT_HOME_WORKSPACE_NAME);
  return Object.keys(state.sessions ?? {}).length === 0 &&
    onlyDefaultOrEmpty &&
    (config.plugins ?? []).length === 0;
}

export interface FirstRunConfigEntries {
  workspace: { name: string; cwd: string };
  agent: { name: string; config: AgentConfig };
}

export async function maybeRunFirstUseOnboarding(input: {
  config: AppConfig;
  state: AppState;
  /**
   * Persists only the onboarding-created workspace and agent entries (targeted
   * config patches) — never the whole parsed config object.
   */
  saveFirstRunConfig: (entries: FirstRunConfigEntries) => Promise<void>;
  deps: OnboardingDeps;
}): Promise<OnboardingResult> {
  if (!isFirstUse(input.config, input.state)) return { created: false };
  if (!input.deps.isInteractive()) return { created: false };

  const cwd = normalizeWorkspacePath(input.deps.cwd());
  const workspaceBase = sanitizeWorkspaceName(basenameForWorkspacePath(cwd));
  if (workspaceBase === null) {
    input.deps.print(t().misc.onboardingWorkspaceNameUnderivable(cwd));
    return { created: false };
  }
  const workspaceName = allocateWorkspaceName(workspaceBase, input.config.workspaces);
  const yes = (await input.deps.promptText(t().misc.onboardingFirstUsePrompt(workspaceName))).trim().toLowerCase();
  if (yes === "n" || yes === "no") return { created: false };

  const templateNames = listAgentTemplates();
  input.deps.print(t().misc.onboardingSelectAgent);
  for (let index = 0; index < templateNames.length; index += 1) {
    input.deps.print(`${index + 1}. ${templateNames[index]}`);
  }
  const answer = (await input.deps.promptText(t().misc.onboardingEnterChoice)).trim();
  const agentName = resolveTemplateChoice(answer, templateNames);
  if (!agentName) {
    input.deps.print(t().misc.onboardingNoValidAgent);
    return { created: false };
  }

  const template = getAgentTemplate(agentName);
  if (!template) return { created: false };

  const workspaceExisted = Boolean(input.config.workspaces[workspaceName]);
  const agentExisted = Boolean(input.config.agents[agentName]);

  input.config.workspaces[workspaceName] = { cwd };
  input.config.agents[agentName] = template;
  await input.saveFirstRunConfig({
    workspace: { name: workspaceName, cwd },
    agent: { name: agentName, config: template },
  });

  const alias = `${workspaceName}:${agentName}`;
  input.deps.print(t().misc.onboardingCreatedWorkspace(workspaceName, alias));
  return {
    created: true,
    workspace: workspaceName,
    workspaceCwd: cwd,
    agent: agentName,
    alias,
    rollback: { workspaceExisted, agentExisted },
  };
}

function resolveTemplateChoice(answer: string, names: string[]): string | null {
  if (!answer) return names[0] ?? null;
  const index = Number.parseInt(answer, 10);
  if (Number.isFinite(index) && index >= 1 && index <= names.length) return names[index - 1]!;
  return names.includes(answer) ? answer : null;
}
