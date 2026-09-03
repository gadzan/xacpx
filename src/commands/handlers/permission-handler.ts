import type { NonInteractivePermissions, PermissionMode, AppConfig } from "../../config/types";
import { cloneAppConfig } from "../config-clone";
import type { HelpTopicMetadata } from "../help/help-types";
import type { CommandRouterContext, RouterResponse } from "../router-types";
import { t } from "../../i18n";
import {
  isEligibleForRuntime,
  parseXacpxPermissionPolicy,
  type XacpxPermissionPolicy,
} from "../../bridge/engine/runtime/runtime-permission-policy";

export function permissionHelp(): HelpTopicMetadata {
  const p = t().permission;
  return {
    topic: "permission",
    aliases: ["pm"],
    summary: p.helpSummary,
    commands: [
      { usage: p.helpCmdShow, description: p.helpCmdShowDesc },
      { usage: p.helpCmdSet, description: p.helpCmdSetDesc },
      { usage: p.helpCmdAuto, description: p.helpCmdAutoDesc },
      { usage: p.helpCmdAutoSet, description: p.helpCmdAutoSetDesc },
    ],
    examples: ["/pm set read", "/pm auto deny"],
  };
}

export function handlePermissionStatus(context: CommandRouterContext): RouterResponse {
  return { text: renderPermissionStatus(context.config, t().permission.statusTitleCurrent) };
}

export async function handlePermissionModeSet(
  context: CommandRouterContext,
  mode: PermissionMode,
): Promise<RouterResponse> {
  const p = t().permission;
  if (!context.config || !context.configStore) {
    return { text: p.noWritableConfig };
  }

  const previous = cloneAppConfig(context.config);
  const previousRaw = await context.configStore.getRawValue(["transport", "permissionMode"]);
  const updated = await context.configStore.updateTransport({
    permissionMode: mode,
  });
  try {
    const hasRuntimeSessions = context.sessions?.hasPersistedRuntimeBindings?.() ?? false;
    if (hasRuntimeSessions) {
      let parsedPolicy: XacpxPermissionPolicy | undefined;
      if (updated.transport.permissionPolicy !== undefined) {
        parsedPolicy = typeof updated.transport.permissionPolicy === "object" && updated.transport.permissionPolicy !== null
          ? (updated.transport.permissionPolicy as XacpxPermissionPolicy)
          : parseXacpxPermissionPolicy(updated.transport.permissionPolicy);
      }
      const eligible = isEligibleForRuntime(parsedPolicy, updated.transport.nonInteractivePermissions, false);
      if (!eligible) {
        throw new Error('cannot apply permission policy: runtime-ineligible policy (nonInteractive="fail" or escalate without interactive) with active runtime sessions');
      }
    }
    await context.transport.updatePermissionPolicy?.(updated.transport);
  } catch (error) {
    // Restore the operator's exact previous raw value (or its absence).
    if (previousRaw.present) {
      await context.configStore.setRawValue(["transport", "permissionMode"], previousRaw.value);
    } else {
      await context.configStore.unsetRawValue(["transport", "permissionMode"]);
    }
    context.replaceConfig(previous);
    throw error;
  }
  context.replaceConfig(updated);
  return { text: renderPermissionStatus(context.config, p.statusTitleModeUpdated) };
}

export function handlePermissionAutoStatus(context: CommandRouterContext): RouterResponse {
  return { text: renderPermissionStatus(context.config, t().permission.statusTitleAutoStatus) };
}

export async function handlePermissionAutoSet(
  context: CommandRouterContext,
  policy: NonInteractivePermissions,
): Promise<RouterResponse> {
  const p = t().permission;
  if (!context.config || !context.configStore) {
    return { text: p.noWritableConfig };
  }

  const previous = cloneAppConfig(context.config);
  const previousRaw = await context.configStore.getRawValue(["transport", "nonInteractivePermissions"]);
  const updated = await context.configStore.updateTransport({
    nonInteractivePermissions: policy,
  });
  try {
    const hasRuntimeSessions = context.sessions?.hasPersistedRuntimeBindings?.() ?? false;
    if (hasRuntimeSessions) {
      let parsedPolicy: XacpxPermissionPolicy | undefined;
      if (updated.transport.permissionPolicy !== undefined) {
        parsedPolicy = typeof updated.transport.permissionPolicy === "object" && updated.transport.permissionPolicy !== null
          ? (updated.transport.permissionPolicy as XacpxPermissionPolicy)
          : parseXacpxPermissionPolicy(updated.transport.permissionPolicy);
      }
      const eligible = isEligibleForRuntime(parsedPolicy, updated.transport.nonInteractivePermissions, false);
      if (!eligible) {
        throw new Error('cannot apply permission policy: runtime-ineligible policy (nonInteractive="fail" or escalate without interactive) with active runtime sessions');
      }
    }
    await context.transport.updatePermissionPolicy?.(updated.transport);
  } catch (error) {
    // Restore the operator's exact previous raw value (or its absence).
    if (previousRaw.present) {
      await context.configStore.setRawValue(["transport", "nonInteractivePermissions"], previousRaw.value);
    } else {
      await context.configStore.unsetRawValue(["transport", "nonInteractivePermissions"]);
    }
    context.replaceConfig(previous);
    throw error;
  }
  context.replaceConfig(updated);
  return { text: renderPermissionStatus(context.config, p.statusTitleAutoUpdated) };
}

export function renderPermissionStatus(config: AppConfig | undefined, title: string): string {
  const permissionMode = config?.transport.permissionMode ?? "approve-all";
  const nonInteractivePermissions = config?.transport.nonInteractivePermissions ?? "deny";

  return [title, `- mode: ${permissionMode}`, `- auto: ${nonInteractivePermissions}`].join("\n");
}
