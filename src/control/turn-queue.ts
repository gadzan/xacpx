import { randomUUID } from "node:crypto";

import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import type { TurnRequest, TurnResult } from "./session-turn-runner";
import {
  turnKey,
  raceWithTimeout,
  type QueuedPrompt,
  CANCEL_DRAIN_TIMEOUT_MS,
  QUEUE_MAX_DEPTH,
  QUEUE_PREVIEW_MAX,
  TURN_IDLE_TIMEOUT_REASON,
  type PeerTurnOrigin,
  type AgentMessageCompletion,
  type TurnIdleTimeoutDetail,
} from "./turn-support";
import type { PermissionInteractionOrigin } from "../permissions/permission-types.js";
import type { ConversationTurnCorrelation } from "./conversation-control-dtos";
