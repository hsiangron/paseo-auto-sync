#!/usr/bin/env node
/**
 * 物理删除 Paseo 的已归档 workspace 记录。
 *
 * 为什么需要它：Paseo 没有删除单个 workspace 的接口 —— CLI 只有
 * `workspace archive`，连 `project delete` 也是把活动 workspace 归档；daemon 的
 * workspace registry 只在启动时读一次 workspaces.json，之后一律按内存整表原子
 * 重写。因此在 daemon 运行期间改这个文件会被下一次写入覆盖，必须在 daemon 停止
 * 时执行。
 *
 * 用法：
 *   paseo daemon stop
 *   node scripts/prune-archived-workspaces.mjs --dry-run   # 先看会删什么
 *   node scripts/prune-archived-workspaces.mjs
 *   paseo daemon start
 *
 * 选项：
 *   --dry-run            只报告，不写文件
 *   --include-worktrees  连 Paseo 自管 worktree 的归档记录一起删
 *                        （默认保留，因为该记录是 Restore 分支的唯一入口）
 *   --force              daemon 仍在运行时也强行写（不要用，写入会被覆盖）
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const includeWorktrees = args.has("--include-worktrees");
const force = args.has("--force");

const paseoHome =
  process.env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
const workspacesFile = path.join(paseoHome, "projects", "workspaces.json");
const pidFile = path.join(paseoHome, "paseo.pid");

/**
 * 确认 daemon 已停止。
 *
 * daemon 会把内存中的整表写回文件，运行期间的外部修改会在下一次写入时被覆盖，
 * 所以默认拒绝写入；只有显式 --force 才继续。只读的 --dry-run 不受此限制。
 */
async function assertDaemonStopped() {
  if (force) {
    return;
  }
  let pid;
  try {
    pid = JSON.parse(await readFile(pidFile, "utf8")).pid;
  } catch {
    return; // 没有 pid 文件就无法判断，按已停止处理
  }
  if (typeof pid !== "number") {
    return;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return; // 进程已不存在
  }
  throw new Error(
    `Paseo daemon (pid ${pid}) is running; run \`paseo daemon stop\` first, or pass --force to write anyway`,
  );
}

/**
 * 判断一条记录是否应被删除。
 *
 * @param record workspaces.json 中的一条 workspace 记录。
 * @returns 已归档且（允许删除 worktree 或它不是 Paseo 自管 worktree）时为 true。
 */
export function isPrunable(record, options = {}) {
  if (!record?.archivedAt) {
    return false;
  }
  if (!options.includeWorktrees && record.isPaseoOwnedWorktree === true) {
    return false;
  }
  return true;
}

const records = JSON.parse(await readFile(workspacesFile, "utf8"));
if (!Array.isArray(records)) {
  throw new Error(`${workspacesFile} is not a JSON array`);
}

const pruned = records.filter((record) => isPrunable(record, { includeWorktrees }));
const kept = records.filter((record) => !isPrunable(record, { includeWorktrees }));
const keptArchivedWorktrees = kept.filter(
  (record) => record.archivedAt && record.isPaseoOwnedWorktree === true,
).length;

console.log(
  `${workspacesFile}: ${records.length} records, ${pruned.length} archived to remove, ${kept.length} to keep`,
);
for (const record of pruned) {
  console.log(
    `  - ${record.workspaceId} ${record.archivedAt} ${record.title ?? record.displayName ?? record.cwd ?? ""}`,
  );
}
if (keptArchivedWorktrees > 0) {
  console.log(
    `  kept ${keptArchivedWorktrees} archived worktree record(s) so their branches stay restorable (--include-worktrees overrides)`,
  );
}

if (pruned.length === 0) {
  console.log("nothing to do");
  process.exit(0);
}
if (dryRun) {
  console.log("dry run: file not modified");
  process.exit(0);
}

// 只有真正写文件时才要求 daemon 已停止。
await assertDaemonStopped();

// 与 daemon 的 writeJsonFileAtomic 保持一致：2 空格缩进、无末尾换行。
const tempFile = `${workspacesFile}.prune-${process.pid}`;
await writeFile(tempFile, JSON.stringify(kept, null, 2), "utf8");
await rename(tempFile, workspacesFile);

const verified = JSON.parse(await readFile(workspacesFile, "utf8"));
const remaining = verified.filter((record) => isPrunable(record, { includeWorktrees })).length;
if (remaining !== 0) {
  throw new Error(`prune verification failed: ${remaining} record(s) still present`);
}
console.log(`wrote ${verified.length} records; restart the daemon to apply`);
