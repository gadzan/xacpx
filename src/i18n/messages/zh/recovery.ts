import type { RecoveryMessages } from "../../types";

export const recovery: RecoveryMessages = {
  adapterRegistryE404: (registry, officialRegistry) =>
    `npm registry ${registry} 返回了 managed adapter E404。请执行 \`xacpx adapter registry set ${officialRegistry}\` 和 \`xacpx restart\`，或让私源管理员代理/放行 @agentclientprotocol scope。`,
  // renderTransportError — transient session
  transientSessionFailed: "定时任务的临时会话启动失败，本次任务未能执行。",
  transientSessionHint: "临时会话由系统在执行时自动创建，无需手动操作；如需重排，请用 /lt 重新安排。",

  // renderTransportError — normal session unavailable
  sessionUnavailable: (alias) => `当前会话「${alias}」暂时不可用。`,
  sessionUnavailableRenewHint: (alias, agent, quotedWorkspace) =>
    `请先在微信里重新执行：/session new ${alias} --agent ${agent} --ws ${quotedWorkspace}`,
  sessionUnavailableAttachHint: (alias, agent, quotedWorkspace) =>
    `如果你要绑定一个已有会话，再执行：/session attach ${alias} --agent ${agent} --ws ${quotedWorkspace} --name <会话名>`,

  // renderTransportError — partial output
  sessionInterrupted: (alias) => `当前会话「${alias}」执行中断，未收到最终回复。`,
  sessionInterruptedHint: "请直接重试；如果长时间无响应，可先发送 /cancel 后再重试。",
  sessionInterruptedError: (summary) => `错误信息：${summary}`,

  // renderTransportError — queue overflow (toast-only on relay-web; silent elsewhere)
  queueOverflowWarning: "",
  queueOverflowHint: "部分回复因过长已收束，可直接继续。",
  queueOverflowUnconfirmedHint: "输出过长且清理未确认，请先发 /cancel 再继续。",
  // renderSessionCreationError (AutoInstallFailedError)
  autoInstallHeadlineFixed: "⚠️ 自动安装已执行但未能修复会话启动问题",
  autoInstallHeadlineFailed: "❌ 自动安装失败",
  autoInstallOriginalError: "原始错误：",
  autoInstallStepVerifyFailed: (label) =>
    `安装已执行但验证失败（${label}）：会话仍抛出缺失依赖错误`,
  autoInstallStepError: (label, stderrTail) => `安装错误（${label}）：\n${stderrTail}`,
  autoInstallManual: (pkg) => `请手动执行：npm install -g ${pkg}`,
  autoInstallLog: (logPath) => `详细日志：${logPath}`,
  autoInstallScopePrecise: (manager, path) => {
    const parts = ["精确"];
    if (manager) parts.push(manager);
    if (path) parts.push(path);
    return parts.join(" / ");
  },
  autoInstallScopeGlobal: "全局",

  // renderSessionCreationFailure / renderSessionCreationVerificationError
  sessionCreationFailed: "会话创建失败。",
  sessionCreationVerificationDetail: "未检测到可用的后端会话。",
  sessionCreationError: (summary) => `错误信息：${summary}`,
  sessionCreationAttachHint: (alias, agent, quotedWorkspace) =>
    `如果你要先绑定一个已有会话，可以执行：/session attach ${alias} --agent ${agent} --ws ${quotedWorkspace} --name <会话名>`,
};
