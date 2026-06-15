import { listHelpTopics } from "./help/help-registry";
import { t } from "../i18n";

export interface CommandHint {
  /** 输入框命令名，含前导斜杠，如 "/session"。 */
  name: string;
  /** 简短描述，取自对应 help topic 的 summary（平台可能截断）。 */
  description: string;
}

/**
 * 每个 help topic 的主命令名。topic 名不一定等于命令名（如 native -> /ssn），
 * 因此用显式映射；新增 topic 若未在此登记，listXacpxCommandHints 会抛错以防静默漂移。
 */
const PRIMARY_COMMAND_BY_TOPIC: Record<string, string> = {
  session: "/session",
  native: "/ssn",
  workspace: "/workspace",
  agent: "/agent",
  permission: "/permission",
  config: "/config",
  orchestration: "/delegate",
  mode: "/mode",
  model: "/model",
  replymode: "/replymode",
  status: "/status",
  cancel: "/cancel",
  later: "/later",
};

/**
 * 从 HELP_TOPICS 派生输入框命令提示（单一真源，与 /help 同源不漂移）。
 * 额外置顶 /help。
 */
export function listXacpxCommandHints(): CommandHint[] {
  const hints: CommandHint[] = [{ name: "/help", description: t().hints.helpDescription }];
  for (const topic of listHelpTopics()) {
    const name = PRIMARY_COMMAND_BY_TOPIC[topic.topic];
    if (!name) {
      throw new Error(`command-hints: no primary command registered for help topic: ${topic.topic}`);
    }
    hints.push({ name, description: topic.summary });
  }
  return hints;
}
