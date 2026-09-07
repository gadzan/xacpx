import type { AgentMessages } from "../../types";

export const agent: AgentMessages = {
  // render-text: renderAgents
  agentsEmpty: "还没有注册任何 Agent。",
  agentsHeader: "已注册的 Agent：",

  // handleAgentAdd / handleAgentRemove — no config
  noWritableConfig: "当前没有加载可写入的配置。",

  // handleAgentAdd — unsupported template
  unsupportedTemplate: (available) => `暂不支持这个 Agent 模板。当前可用：${available}`,

  // handleAgentAdd — already exists (identical)
  alreadyExists: (name) => `Agent「${name}」已存在`,

  // handleAgentAdd — already exists (different config)
  alreadyExistsDifferent: (name) => `Agent「${name}」已存在且配置不同。请先执行 /agent rm ${name}`,

  // handleAgentAdd — saved confirmation
  saved: (name) => `Agent「${name}」已保存`,

  // handleAgentRemove — not found
  notFound: "没有找到这个 Agent。",

  // handleAgentRemove — removed confirmation
  removed: (name) => `Agent「${name}」已删除`,

  // handleAgentRemove — still referenced by persisted sessions
  stillReferenced: (name, aliases) =>
    `Agent「${name}」仍被以下会话使用：${aliases}。请先删除这些会话。`,

  // agentHelp metadata
  helpSummary: "管理已注册的 Agent。",
  helpCmdList: "/agents",
  helpCmdListDesc: "查看当前已注册的 Agent",
  helpCmdAdd: (templates) => `/agent add <${templates}>`,
  helpCmdAddDesc: "添加内置 Agent 模板",
  helpCmdRm: "/agent rm <name>",
  helpCmdRmDesc: "删除一个 Agent",
};
