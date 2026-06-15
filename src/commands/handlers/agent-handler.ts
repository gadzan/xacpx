import { renderAgents } from "../../formatting/render-text";
import { getAgentTemplate, listAgentTemplates, sameAgentConfig } from "../../config/agent-templates";
import type { HelpTopicMetadata } from "../help/help-types";
import type { CommandRouterContext, RouterResponse } from "../router-types";
import { t } from "../../i18n";

export function agentHelp(): HelpTopicMetadata {
  const a = t().agent;
  return {
    topic: "agent",
    aliases: ["agents"],
    summary: a.helpSummary,
    commands: [
      { usage: a.helpCmdList, description: a.helpCmdListDesc },
      { usage: a.helpCmdAdd(listAgentTemplates().join("|")), description: a.helpCmdAddDesc },
      { usage: a.helpCmdRm, description: a.helpCmdRmDesc },
    ],
    examples: ["/agent add claude", "/agent rm codex"],
  };
}

export function handleAgents(context: CommandRouterContext): RouterResponse {
  return { text: context.config ? renderAgents(context.config) : "No config loaded." };
}

export async function handleAgentAdd(context: CommandRouterContext, templateName: string, model?: string): Promise<RouterResponse> {
  const a = t().agent;
  if (!context.config || !context.configStore) {
    return { text: a.noWritableConfig };
  }

  const template = getAgentTemplate(templateName);
  if (!template) {
    return { text: a.unsupportedTemplate(listAgentTemplates().join("、")) };
  }

  const normalizedModel = model?.trim();
  const desired = normalizedModel ? { ...template, model: normalizedModel } : template;

  const existing = context.config.agents[templateName];
  if (existing) {
    // Same driver/command and same model → genuine no-op. A differing model with
    // the same base is treated as an update (the user explicitly passed --model).
    if (sameAgentConfig(existing, desired)) {
      if ((existing.model ?? undefined) === (desired.model ?? undefined)) {
        return { text: a.alreadyExists(templateName) };
      }
    } else {
      return { text: a.alreadyExistsDifferent(templateName) };
    }
  }

  const updated = await context.configStore.upsertAgent(templateName, desired);
  context.replaceConfig(updated);
  return { text: a.saved(templateName) };
}

export async function handleAgentRemove(context: CommandRouterContext, agentName: string): Promise<RouterResponse> {
  const a = t().agent;
  if (!context.config || !context.configStore) {
    return { text: a.noWritableConfig };
  }
  if (!context.config.agents[agentName]) {
    return { text: a.notFound };
  }

  const updated = await context.configStore.removeAgent(agentName);
  context.replaceConfig(updated);
  return { text: a.removed(agentName) };
}
