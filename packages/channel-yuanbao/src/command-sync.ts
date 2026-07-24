import type { AppLogger } from "xacpx/plugin-api";
import type { WsSyncCommand, WsSyncInformationData } from "./access/ws/types.js";

// 与 packages/channel-yuanbao/package.json 的 version 一致；同步测试校验防漂移。
export const PLUGIN_VERSION = "0.6.0-beta.0";

// 元宝协议 SyncInformationType.SYNC_INFORMATION_TYPE_COMMANDS。
const SYNC_TYPE_COMMANDS = 1;

export interface YuanbaoCommandSyncInput {
  botVersion: string;
  pluginVersion: string;
  /** weacpx 的命令清单（走 pluginCommands 自由桶，见下） */
  commands: WsSyncCommand[];
}

/** 把命令同步入参映射为元宝 WS 的 SyncInformation 请求数据。 */
export function toSyncInformationData(input: YuanbaoCommandSyncInput): WsSyncInformationData {
  return {
    syncType: SYNC_TYPE_COMMANDS,
    botVersion: input.botVersion,
    pluginVersion: input.pluginVersion,
    commandData: {
      // 元宝/OpenClaw 后端把 botCommands 校验进它**内置的框架命令词表**，不认识的名字
      // 会被丢弃——我们把全部 13 个塞进 botCommands 时，只有 /help、/status（词表交集）
      // 留下了。自定义命令必须走 pluginCommands —— 这是后端按原样渲染的自由桶
      // （OpenClaw 自己的 /yuanbaobot-upgrade、/issue-log 就是这样出现的）。
      botCommands: [],
      pluginCommands: input.commands,
    },
  };
}

/** syncCommandsOnReady 所需的最小 WS 客户端能力（便于单测注入假对象）。 */
export interface CommandSyncClient {
  syncInformation(data: WsSyncInformationData): Promise<{ code: number }>;
}

/**
 * 连接就绪（含每次重连）后向元宝后端 best-effort 同步命令提示。
 * - 无命令或客户端缺失时静默跳过；
 * - 失败/后端拒绝只记日志，绝不抛错（fire-and-forget，永远 resolve）。
 * 返回 Promise 仅供测试 await；调用方以 `void` 调用即可。
 */
export async function syncCommandsOnReady(
  client: CommandSyncClient | undefined,
  commandSync: YuanbaoCommandSyncInput | undefined,
  logger: Pick<AppLogger, "info" | "error">,
  accountId: string,
): Promise<void> {
  if (!client || !commandSync || commandSync.commands.length === 0) {
    return;
  }
  try {
    const rsp = await client.syncInformation(toSyncInformationData(commandSync));
    if (rsp.code === 0) {
      await logger.info("yuanbao.ws.sync_commands", "synced command hints", {
        accountId,
        code: rsp.code,
        count: commandSync.commands.length,
      });
    } else {
      await logger.error("yuanbao.ws.sync_commands_rejected", "command hint sync rejected by backend", {
        accountId,
        code: rsp.code,
        count: commandSync.commands.length,
      });
    }
  } catch (err) {
    await logger.error("yuanbao.ws.sync_commands_failed", "command hint sync failed", {
      accountId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
