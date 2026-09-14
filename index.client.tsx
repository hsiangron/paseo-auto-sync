import type { PluginClientContext } from "@getpaseo/plugin/client";
import { syncSessionsRpc } from "./shared/sync";

/**
 * 在 Paseo 客户端加载插件时触发本机 Codex 与 Pi 会话同步。
 *
 * @param client Paseo 客户端插件上下文。
 * @returns 用于移除插件注册项的清理函数。
 */
export default function contribute(client: PluginClientContext) {
  void client.rpc(syncSessionsRpc, {}).catch((error: unknown) => {
    console.error("[paseo-auto-sync] Failed to request startup sync", error);
  });

  return client.addCommandCenterItem({
    id: "sync-local-sessions",
    title: "Sync local Codex and Pi sessions",
    icon: "RefreshCw",
    keywords: ["codex", "pi", "session", "sync"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(syncSessionsRpc, {});
    },
  });
}
