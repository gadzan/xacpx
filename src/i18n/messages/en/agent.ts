import type { AgentMessages } from "../../types";

export const agent: AgentMessages = {
  // render-text: renderAgents
  agentsEmpty: "No agents registered yet.",
  agentsHeader: "Registered agents:",

  // handleAgentAdd / handleAgentRemove — no config
  noWritableConfig: "No writable config is currently loaded.",

  // handleAgentAdd — unsupported template
  unsupportedTemplate: (available) => `This agent template is not supported. Available: ${available}`,

  // handleAgentAdd — already exists (identical)
  alreadyExists: (name) => `Agent "${name}" already exists.`,

  // handleAgentAdd — already exists (different config)
  alreadyExistsDifferent: (name) =>
    `Agent "${name}" already exists with a different configuration. Run /agent rm ${name} first.`,

  // handleAgentAdd — saved confirmation
  saved: (name) => `Agent "${name}" saved.`,

  // handleAgentRemove — not found
  notFound: "Agent not found.",

  // handleAgentRemove — removed confirmation
  removed: (name) => `Agent "${name}" removed.`,

  // handleAgentRemove — still referenced by persisted sessions
  stillReferenced: (name, aliases) =>
    `Agent "${name}" is still used by sessions: ${aliases}. Remove those sessions first.`,

  // agentHelp metadata
  helpSummary: "Manage registered agents.",
  helpCmdList: "/agents",
  helpCmdListDesc: "List all registered agents",
  helpCmdAdd: (templates) => `/agent add <${templates}>`,
  helpCmdAddDesc: "Add a built-in agent template",
  helpCmdRm: "/agent rm <name>",
  helpCmdRmDesc: "Remove an agent",
};
