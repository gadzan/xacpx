import type { HelpTopicMetadata } from "./help-types";
import { agentHelp } from "../handlers/agent-handler";
import { configHelp } from "../handlers/config-handler";
import { orchestrationHelp } from "../handlers/orchestration-handler";
import { permissionHelp } from "../handlers/permission-handler";
import {
  cancelHelp,
  modeHelp,
  modelHelp,
  nativeSessionHelp,
  replyModeHelp,
  sessionHelp,
  statusHelp,
} from "../handlers/session-handler";
import { workspaceHelp } from "../handlers/workspace-handler";
import { laterHelp } from "../handlers/later-handler";

function buildHelpTopics(): HelpTopicMetadata[] {
  return [
    sessionHelp(),
    nativeSessionHelp(),
    workspaceHelp(),
    agentHelp(),
    permissionHelp(),
    configHelp(),
    orchestrationHelp(),
    modeHelp(),
    modelHelp(),
    replyModeHelp(),
    statusHelp(),
    cancelHelp(),
    laterHelp(),
  ];
}

export function getHelpTopic(topic: string): HelpTopicMetadata | null {
  const topics = buildHelpTopics();
  for (const entry of topics) {
    if (entry.topic === topic) return entry;
    if (entry.aliases.includes(topic)) return entry;
  }
  return null;
}

export function listHelpTopics(): HelpTopicMetadata[] {
  return buildHelpTopics();
}
