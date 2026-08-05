import type { CliMessages } from "../../types";

export const cli: CliMessages = {
  // HELP_LINES — usage text printed by --help and on unknown commands
  helpLines: [
    "用法：",
    "xacpx login  - 微信登录",
    "xacpx logout - 退出登录",
    "xacpx run    - 前台运行",
    "xacpx start  - 后台启动",
    "xacpx status - 查看状态",
    "xacpx stop   - 停止服务",
    "xacpx restart - 重启后台服务",
    "xacpx update [--all|<name>] - 更新 xacpx 和已安装插件",
    "xacpx channel|ch list|show|add|rm|enable|disable [--account <id>] - 管理消息频道（多 bot 用 --account）",
    "xacpx plugin list|add|update|remove|enable|disable|doctor|known - 管理插件",
    "xacpx doctor - 运行诊断",
    "xacpx version - 查看版本",
    "xacpx agent|agents list|add|rm|templates - 管理本机 Agent",
    "xacpx adapter list|check [name]|update (<name>|--all)|set <name> <version>|reset <name>|uninstall <name> <release> - 管理 ACP adapter",
    "xacpx adapter registry [set <url>|reset] - 管理 ACP adapter npm registry",
    "xacpx workspace list|add [name] [--raw]|rm <name> - 管理本机工作区（别名：ws）",
    "xacpx later|lt list|cancel <id> - 管理本机待执行定时任务",
    "xacpx mcp-stdio [--coordinator-session <session>] [--source-handle <handle>] [--workspace <name>] - 启动 MCP stdio 服务",
  ],

  // start command
  alreadyRunning: "xacpx 已在后台运行",
  started: "xacpx 已在后台启动",
  startFailed: (detail) => `xacpx 启动失败：${detail}`,

  // status command
  running: "xacpx 正在运行",
  notRunning: "xacpx 未运行",
  indeterminate: "xacpx 进程仍在运行，但状态元数据缺失",

  // stop command
  stopped: "xacpx 已停止",

  // restart command
  restarting: "xacpx 正在重启...",
  restartNotRunning: "xacpx 未运行，正在启动...",
  restartFailed: (detail) => `xacpx 重启失败：${detail}`,
  restartIndeterminate: "xacpx 进程仍在运行，但状态元数据缺失",
  restartIndeterminateHint: "请先执行 `xacpx stop`，或手动清理 stale PID/status 后再重试。",

  // daemon log hints
  checkAppLog: (path) => `请查看 App Log: ${path}`,
  checkStderrLog: (path) => `请查看 Stderr: ${path}`,

  // workspace commands
  workspaceEmpty: "还没有工作区。",
  workspaceListHeader: "工作区列表：",
  workspaceNameEmpty: "工作区名称不能为空。",
  workspaceNameSanitized: (sourceLabel, original, saved) =>
    `${sourceLabel} ${JSON.stringify(original)} 含有特殊字符，已保存为「${saved}」。如需保留原名请加 --raw。`,
  workspaceSourceLabelDir: "目录名",
  workspaceSourceLabelName: "名称",
  workspaceAlreadyExists: (name, cwd) => `工作区「${name}」已存在：${cwd}`,
  workspaceConflictPath: (name, cwd) => `工作区「${name}」已存在，但路径不同：${cwd}`,
  workspaceConflictHint: (name) => `请换一个名称，或先执行：xacpx workspace rm ${name}`,
  workspaceSaved: (name, cwd) => `工作区「${name}」已保存：${cwd}`,
  workspaceNotFound: (name) => `没有找到工作区「${name}」。`,
  workspaceRemoved: (name) => `工作区「${name}」已删除`,

  // agent commands
  agentEmpty: "还没有 Agent。",
  agentListHeader: "Agent 列表：",
  agentTemplatesHeader: "可用 Agent 模板：",
  agentNameEmpty: "Agent 名称不能为空。",
  agentUnsupportedTemplate: (templates) => `暂不支持这个 Agent 模板。当前可用：${templates.join("、")}`,
  agentAlreadyExists: (name) => `Agent「${name}」已存在`,
  agentAlreadyExistsDifferent: (name) => `Agent「${name}」已存在且配置不同。请先执行：xacpx agent rm ${name}`,
  agentSaved: (name) => `Agent「${name}」已保存`,
  agentNotFound: (name) => `没有找到 Agent「${name}」。`,
  agentRemoved: (name) => `Agent「${name}」已删除`,

  // adapter commands
  adapterListHeader: "受管 ACP adapter：",
  adapterListRow: (id, effective, defaultVersion, source) =>
    `${id}：生效=${effective} 默认=${defaultVersion} 来源=${source}`,
  adapterSourceDefault: "xacpx 默认",
  adapterSourceConfigured: "本机配置",
  adapterUnsupported: (id) => `不支持受管 adapter「${id}」。可用：codex、claude`,
  adapterInvalidVersion: (version) => `Adapter 版本必须是精确 semver：${version}`,
  adapterVersionUnavailable: (id, version) => `npm 未发布 ${id} adapter 版本 ${version}。`,
  adapterLatestUnavailable: (id) => `无法从 npm 获取 ${id} adapter 的最新版本。`,
  adapterCheckRow: (id, effective, latest) => `${id}：生效=${effective} 最新=${latest}`,
  adapterAlreadyLatest: (id, version) => `${id} 已使用最新 adapter 版本 ${version}。`,
  adapterVerifying: (id, version) => `正在通过 ACP initialize 验证 ${id} adapter ${version}…`,
  adapterSaved: (id, version) => `${id} adapter 版本已设置为 ${version}。`,
  adapterReset: (id, version) => `${id} adapter 本机覆盖已删除；当前生效版本为 ${version}。`,
  adapterFailed: (id, detail) => `${id} adapter 更新失败：${detail}`,
  adapterRestartRequired: "请重启 xacpx daemon 后再使用新的 adapter 配置。",
  adapterRegistryCurrent: (registry, source) => `Adapter registry：${registry}（来源=${source}）`,
  adapterRegistrySaved: (registry) => `Adapter registry 已设置为 ${registry}。`,
  adapterRegistryReset: (registry) => `Adapter registry 本机覆盖已删除；当前使用 ${registry}。`,
  adapterInvalidRegistry: (detail) => `Adapter registry 无效：${detail}`,
  adapterInstalledHeader: "已安装的受管 adapter release：",
  adapterInstalledRow: (id, releaseId, active) => `${id}：${releaseId}${active ? "（当前）" : ""}`,
  adapterPreinstalled: (id, version, releaseId) => `已预安装 ${id} adapter ${version}（${releaseId}）。`,
  adapterUninstalled: (id, releaseId, alreadyMissing) => alreadyMissing
    ? `${id} adapter release ${releaseId} 已不存在。`
    : `已卸载 ${id} adapter release ${releaseId}。`,
  adapterUninstallProtected: (id, releaseId, reason) =>
    `拒绝卸载 ${id} adapter release ${releaseId}：${reason}。`,

  // later commands
  laterIdEmpty: "定时任务 ID 不能为空。",
  laterNotFound: (id) => `未找到待执行的定时任务 #${id}。`,
  laterNotFoundHint: "可以用 xacpx later list 查看当前待执行任务。",
  laterCancelled: (id) => `已取消定时任务 #${id}`,
};
