# paseo-auto-sync

[English](README.md)

Paseo 插件：自动导入本机 Codex 与 Pi 会话，并清理原生会话已不存在的 Paseo 记录。做法与 Gaseo 一致，链接而非复制：原始 JSONL 仍留在各 provider 目录，Paseo 只保存用于恢复会话的句柄。

## 行为

- 服务端插件启动、Paseo 客户端加载时同步，并在 daemon 持续运行期间每 24 小时同步一次。
- Pi/Codex 原生会话已不存在时，硬删除 idle 或 closed 的 Paseo agent；绝不删除 running agent。
- 只有一个 workspace 内的全部 agent 都被成功清理后才归档该 workspace，共享 workspace 不受影响。
- 多个窗口并发触发会合并为同一次进行中的同步。
- 每个导入的会话会单独建一个 workspace，这样才能出现在侧边栏。直接 `paseo import` 会把同一目录下的会话全部塞进该目录最早的那个 workspace。
- 将进行中与已归档的 Paseo agent 都视为已登记，避免下次启动把归档会话重新建出来。
- 导入 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 里的主会话。Codex 的 `exec` / subagent 记录，以及 Pi 的 `forks` 或 `run-*/session.jsonl` 都会跳过。
- 原始工作目录在本机已不存在的会话会跳过。
- 当前被 writer 占用的 Codex 会话会延后，等到下次同步再试。
- 由本插件创建的 agent 会打上 `paseo-auto-sync=true`。
- Command Center 增加 **Sync local Codex and Pi sessions**，可手动重试。

## 资源限制

每个导入的会话都会占用一个 provider 运行时，直到 Paseo daemon 卸载它。为避免首次安装一次拉起几十个 `codex app-server` 进程，每次同步默认最多导入 **50** 个新会话，优先最新。剩余会话会在之后打开 Paseo 或通过 Command Center 重试时继续导入。

用 `PASEO_AUTO_SYNC_BATCH_SIZE` 设置批次大小，取值 `1` 到 `50`。

大批量首次导入之后，执行 `paseo daemon restart` 可以释放这些运行时，已导入的 agent 记录不会丢失。其他 agent 仍在工作时不要重启。

## 安装

插件源码应放在 Paseo 家目录内，不要作为 `$HOME` 下的独立仓库：

```bash
git clone https://github.com/hsiangron/paseo-auto-sync.git ~/.paseo/plugins/paseo-auto-sync
cd ~/.paseo/plugins/paseo-auto-sync
npm install
paseo plugin install ~/.paseo/plugins/paseo-auto-sync
```

本地修改后重新加载插件：

```bash
paseo plugin reload paseo-auto-sync
```

## 配置

插件会读取下列环境变量。未设置时使用表中的默认值。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 主目录；会话从 `$CODEX_HOME/sessions` 和 `$CODEX_HOME/archived_sessions` 读取 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent 目录 |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Pi 会话 JSONL 根目录 |
| `PASEO_HOME` | `~/.paseo` | Paseo 数据目录，用于去重（含已归档记录） |
| `PASEO_CLI` | `PATH` 上的 `paseo`，再回退常见安装路径 | 用于导入会话并清理悬空 Paseo 记录 |
| `PASEO_AUTO_SYNC_BATCH_SIZE` | `50`（`1`–`50`） | 每次同步最多导入的新会话数 |
| `PASEO_AUTO_SYNC_INTERVAL_HOURS` | `24`（`1`–`168`） | 定时同步与悬空会话清理间隔 |

## 清理已归档的 workspace 记录

每个导入的会话都会单独占一个 workspace。插件清掉悬空 agent 后会归档该 workspace，因为 Paseo 没有删除单个 workspace 的接口：`paseo workspace` 只有 `archive`，连 `paseo project delete` 也是把要移除的活动 workspace 归档。归档记录会留在 `~/.paseo/projects/workspaces.json`，侧边栏看不到但会持续累积。

workspace registry 只在 daemon 启动时读一次这个文件，之后每次变动都按内存整表重写，所以外部修改只有在重启后重新载入才生效。清理时先停 daemon：

```bash
paseo daemon stop
node scripts/prune-archived-workspaces.mjs --dry-run   # 先看会删哪些
node scripts/prune-archived-workspaces.mjs
paseo daemon start
```

脚本在 daemon 运行期间拒绝写入；默认保留 Paseo 自管 worktree 的归档记录（该记录是 Restore 分支的唯一入口）；按 daemon 自己的格式原子重写文件。

## 开发

```bash
npm install
npm test
npm run typecheck
```
