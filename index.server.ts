import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createSessionSyncController } from "./server/sync";
import { syncSessionsRpc } from "./shared/sync";

/**
 * 注册自动同步 RPC，并在服务端插件启动时执行一次同步。
 *
 * @param server Paseo 服务端插件上下文。
 * @returns 停止后台同步任务的清理函数。
 */
export default function contribute(server: PluginServerContext) {
  const controller = createSessionSyncController();

  server.handle(syncSessionsRpc, () => controller.trigger());
  void controller.trigger();

  return () => controller.dispose();
}
