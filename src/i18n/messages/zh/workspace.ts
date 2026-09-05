import type { WorkspaceMessages } from "../../types";

export const workspace: WorkspaceMessages = {
  // render-text: renderWorkspaces
  workspacesEmpty: "还没有注册任何工作区。",
  workspacesHeader: "已注册的工作区：",

  // handleWorkspaceCreate — no config
  noWritableConfig: "当前没有加载可写入的配置。",

  // handleWorkspaceCreate — path not found
  pathNotFound: (cwd) => `工作区路径不存在：${cwd}`,

  // handleWorkspaceCreate — name sanitization notice
  nameSanitized: (original, saved) =>
    `名称 ${JSON.stringify(original)} 含有特殊字符，已保存为「${saved}」。如需保留原名请加 --raw。`,

  // handleWorkspaceCreate — saved confirmation
  saved: (name) => `工作区「${name}」已保存`,

  // handleWorkspaceRemove — removed confirmation
  removed: (name) => `工作区「${name}」已删除`,

  // handleWorkspaceRemove — still referenced by persisted sessions
  stillReferenced: (name, aliases) =>
    `工作区「${name}」仍被以下会话使用：${aliases}。请先删除这些会话。`,

  // workspaceHelp metadata
  helpSummary: "管理已注册的工作区。",
  helpCmdList: "/workspaces",
  helpCmdListDesc: "查看当前已注册的工作区",
  helpCmdListOrAlias: "/workspace 或 /ws",
  helpCmdListOrAliasDesc: "查看工作区列表",
  helpCmdNew: "/ws new <name> -d <path> [--raw]",
  helpCmdNewDesc: "添加工作区；含特殊字符的名称会被自动规范化，--raw 保留原名",
  helpCmdRm: "/workspace rm <name>",
  helpCmdRmDesc: "删除工作区",
};
