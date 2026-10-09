import { access } from "node:fs/promises";

import { loadConfig } from "../../config/load-config";
import type { AppConfig } from "../../config/types";
import { resolveRuntimePaths, type RuntimePaths } from "../../main";
import { resolveProductionRouter } from "../../conversations/production-router";
import type { DoctorCheckResult } from "../doctor-types";

export interface ConversationRouterCheckOptions {
  resolveRuntimePaths?: () => RuntimePaths;
  loadConfig?: (configPath: string) => Promise<AppConfig>;
  env?: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
}

export async function checkConversationRouter(
  options: ConversationRouterCheckOptions = {},
): Promise<DoctorCheckResult> {
  const runtimePaths = (options.resolveRuntimePaths ?? resolveRuntimePaths)();
  try {
    await access(runtimePaths.configPath);
  } catch {
    return {
      id: "conversation-router",
      label: "Conversation router",
      severity: "skip",
      summary: "config is not available, so automatic collaboration was not checked",
      details: [`config path: ${runtimePaths.configPath}`],
    };
  }
  try {
    const config = await (options.loadConfig ?? loadConfig)(runtimePaths.configPath);
    const resolution = await resolveProductionRouter({
      config,
      env: options.env ?? process.env,
      ...(options.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
    });
    const availability = resolution.availability;
    const details = [`config path: ${availability.configPath}`, `status: ${availability.status}`];
    if (availability.status !== "ready") details.push(`reason: ${availability.reason.code}`);
    if (availability.status === "failed") {
      return {
        id: "conversation-router",
        label: "Conversation router",
        severity: "fail",
        summary: availability.reason.message,
        details,
      };
    }
    if (availability.status === "unsupported") {
      return {
        id: "conversation-router",
        label: "Conversation router",
        severity: "warn",
        summary: availability.reason.message,
        details,
      };
    }
    return {
      id: "conversation-router",
      label: "Conversation router",
      severity: "pass",
      summary: availability.status === "ready"
        ? "automatic collaboration router proved its capability limit"
        : "automatic collaboration is off",
      details,
    };
  } catch (error) {
    return {
      id: "conversation-router",
      label: "Conversation router",
      severity: "skip",
      summary: "automatic collaboration was not checked",
      details: [error instanceof Error ? error.message : String(error)],
    };
  }
}
