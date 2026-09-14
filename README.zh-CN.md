# paseo-auto-sync

[English](README.md)

Paseo v0.8 插件：在 Paseo 客户端加载时导入本机 Codex 与 Pi 会话。做法与 Gaseo 一致，链接而非复制：原始 JSONL 仍留在各 provider 目录，Paseo 只保存用于恢复会话的句柄。

## 行为

- 服务端插件启动时同步一次，Paseo 客户端加载时再同步一次。
- 多个窗口并发触发会合并为同一次进行中的同步。
- 通过 `paseo import` 导入，会话历史和恢复行为仍由 Paseo 管理。
- 将进行中与已归档的 Paseo agent 都视为已登记，避免下次启动把归档会话重新建出来。
- 只导入主会话。Codex 的 `exec` / subagent 记录，以及 Pi 的 `forks` 或 `run-*/session.jsonl` 都会跳过。
- 原始工作目录在本机已不存在的会话会跳过。
- 当前被 writer 占用的 Codex 会话会延后，等到下次同步再试。
- 由本插件创建的 agent 会打上 `paseo-auto-sync=true`。
- Command Center 增加 **Sync local Codex and Pi sessions**，可手动重试。

## 资源限制

每个导入的会话都会占用一个 provider 运行时，直到 Paseo daemon 卸载它。为避免首次安装一次拉起几十个 `codex app-server` 进程，每次同步默认最多导入 **3** 个新会话，优先最新。剩余会话会在之后打开 Paseo 或通过 Command Center 重试时继续导入。

用 `PASEO_AUTO_SYNC_BATCH_SIZE` 设置批次大小，取值 `1` 到 `50`。

大批量首次导入之后，执行 `paseo daemon restart` 可以释放这些运行时，已导入的 agent 记录不会丢失。其他 agent 仍在工作时不要重启。

## 安装

```bash
git clone https://github.com/hsiangron/paseo-auto-sync.git
cd paseo-auto-sync
npm install
paseo plugin install /absolute/path/to/paseo-auto-sync
```

本地修改后重新加载插件：

```bash
paseo plugin reload paseo-auto-sync
```

## 配置

插件会读取下列环境变量。未设置时使用表中的默认值。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 主目录；会话从 `$CODEX_HOME/sessions` 读取 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent 目录 |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Pi 会话 JSONL 根目录 |
| `PASEO_HOME` | `~/.paseo` | Paseo 数据目录，用于去重（含已归档记录） |
| `PASEO_CLI` | `PATH` 上的 `paseo`，再回退常见安装路径 | 用于执行 `paseo import` |
| `PASEO_AUTO_SYNC_BATCH_SIZE` | `3`（`1`–`50`） | 每次同步最多导入的新会话数 |

## 开发

```bash
npm install
npm test
npm run typecheck
```
