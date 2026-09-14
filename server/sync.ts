import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const JSONL_EXTENSION = ".jsonl";
const AUTO_SYNC_LABEL = "paseo-auto-sync=true";
const IMPORT_TIMEOUT_MS = 120_000;
const DEFAULT_IMPORT_BATCH_SIZE = 3;
const MAX_IMPORT_BATCH_SIZE = 50;

// 匹配 Pi 的分支会话和子任务会话，它们不是会话列表中的主会话。
const PI_INTERNAL_SESSION_PATH = /(?:^|[\\/])forks[\\/]|[\\/]run-\d+[\\/]session\.jsonl$/u;

type Provider = "codex" | "pi";

export interface LocalSession {
  provider: Provider;
  providerHandleId: string;
  sessionId: string;
  cwd: string;
  sourcePath: string;
  modifiedAt: number;
}

export interface DiscoveryResult {
  sessions: LocalSession[];
  skippedInvalid: Record<Provider, number>;
}

export interface SyncResult {
  discovered: Record<Provider, number>;
  imported: Record<Provider, number>;
  skippedRegistered: Record<Provider, number>;
  skippedInvalid: Record<Provider, number>;
  deferred: Record<Provider, number>;
  remaining: Record<Provider, number>;
  failed: Record<Provider, number>;
}

interface SyncOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  signal?: AbortSignal;
  batchSize?: number;
  importSession?: (session: LocalSession, signal?: AbortSignal) => Promise<void>;
}

interface SessionSyncController {
  trigger(): { status: "started" | "running" };
  dispose(): void;
}

/**
 * 创建带 single-flight 保护的同步控制器，合并多个 Paseo 窗口的并发触发。
 *
 * @returns 可触发同步和取消后台任务的控制器。
 */
export function createSessionSyncController(): SessionSyncController {
  let activeSync: Promise<void> | null = null;
  let abortController: AbortController | null = null;

  return {
    trigger() {
      if (activeSync) {
        return { status: "running" };
      }

      abortController = new AbortController();
      activeSync = syncLocalSessions({ signal: abortController.signal })
        .then((result) => {
          console.info("[paseo-auto-sync] Sync completed", result);
        })
        .catch((error: unknown) => {
          if (!abortController?.signal.aborted) {
            console.error("[paseo-auto-sync] Sync failed", error);
          }
        })
        .finally(() => {
          activeSync = null;
          abortController = null;
        });

      return { status: "started" };
    },
    dispose() {
      abortController?.abort();
    },
  };
}

/**
 * 扫描本机 Codex 与 Pi 主会话，并返回可用于 Paseo import 的原生句柄。
 *
 * @param options 可选的环境变量与主目录覆盖，主要用于测试和自定义安装路径。
 * @returns 会话列表以及因格式或目录无效而跳过的数量。
 */
export async function discoverLocalSessions(options: SyncOptions = {}): Promise<DiscoveryResult> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const codexHome = resolveConfiguredPath(env.CODEX_HOME, path.join(homeDir, ".codex"), homeDir);
  const piAgentDir = resolveConfiguredPath(
    env.PI_CODING_AGENT_DIR,
    path.join(homeDir, ".pi", "agent"),
    homeDir,
  );
  const piSessionsDir = resolveConfiguredPath(
    env.PI_CODING_AGENT_SESSION_DIR,
    path.join(piAgentDir, "sessions"),
    homeDir,
  );

  const [codex, pi] = await Promise.all([
    discoverCodexSessions(path.join(codexHome, "sessions"), options.signal),
    discoverPiSessions(piSessionsDir, options.signal),
  ]);

  const sessionsByKey = new Map<string, LocalSession>();
  for (const session of [...codex.sessions, ...pi.sessions]) {
    const key = sessionKey(session.provider, session.providerHandleId);
    const current = sessionsByKey.get(key);
    if (!current || current.modifiedAt < session.modifiedAt) {
      sessionsByKey.set(key, session);
    }
  }

  return {
    sessions: [...sessionsByKey.values()].sort((left, right) => right.modifiedAt - left.modifiedAt),
    skippedInvalid: {
      codex: codex.skippedInvalid,
      pi: pi.skippedInvalid,
    },
  };
}

/**
 * 读取 Paseo 已保存的 active 与 archived agent，生成原生 session 去重键。
 *
 * @param paseoHome Paseo 数据目录，默认由调用方按环境解析。
 * @returns 已在 Paseo 中存在的 provider/session 组合。
 */
export async function readRegisteredSessionKeys(paseoHome: string): Promise<Set<string>> {
  const agentFiles = await walkFiles(path.join(paseoHome, "agents"), ".json");
  const keys = new Set<string>();

  await Promise.all(
    agentFiles.map(async (file) => {
      try {
        const record = JSON.parse(await readFile(file, "utf8")) as {
          persistence?: {
            provider?: unknown;
            sessionId?: unknown;
            nativeHandle?: unknown;
          } | null;
        };
        const provider = record.persistence?.provider;
        if (provider !== "codex" && provider !== "pi") {
          return;
        }
        if (typeof record.persistence?.sessionId === "string") {
          keys.add(sessionKey(provider, record.persistence.sessionId));
        }
        if (typeof record.persistence?.nativeHandle === "string") {
          keys.add(sessionKey(provider, record.persistence.nativeHandle));
        }
      } catch {
        // 单个损坏记录不应阻断其他会话同步，Paseo 自身仍负责报告该记录问题。
      }
    }),
  );

  return keys;
}

/**
 * 将尚未登记的本机主会话逐个导入 Paseo，并继续处理单个失败项。
 *
 * @param options 环境、取消信号和测试用导入函数覆盖。
 * @returns 各 provider 的发现、导入、跳过和失败计数。
 */
export async function syncLocalSessions(options: SyncOptions = {}): Promise<SyncResult> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const paseoHome = resolveConfiguredPath(env.PASEO_HOME, path.join(homeDir, ".paseo"), homeDir);
  const [discovery, registeredKeys] = await Promise.all([
    discoverLocalSessions({ ...options, env, homeDir }),
    readRegisteredSessionKeys(paseoHome),
  ]);
  const importSession = options.importSession ?? importWithPaseoCli;
  const result = createEmptyResult(discovery.skippedInvalid);
  const batchSize = resolveBatchSize(options.batchSize, env.PASEO_AUTO_SYNC_BATCH_SIZE);
  let attemptedImports = 0;

  for (const session of discovery.sessions) {
    throwIfAborted(options.signal);
    result.discovered[session.provider] += 1;

    const handleKey = sessionKey(session.provider, session.providerHandleId);
    const idKey = sessionKey(session.provider, session.sessionId);
    if (registeredKeys.has(handleKey) || registeredKeys.has(idKey)) {
      result.skippedRegistered[session.provider] += 1;
      continue;
    }

    if (attemptedImports >= batchSize) {
      result.remaining[session.provider] += 1;
      continue;
    }

    attemptedImports += 1;
    try {
      await importSession(session, options.signal);
      registeredKeys.add(handleKey);
      registeredKeys.add(idKey);
      result.imported[session.provider] += 1;
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        throw error;
      }
      if (isAlreadyImportedError(error)) {
        registeredKeys.add(handleKey);
        registeredKeys.add(idKey);
        result.skippedRegistered[session.provider] += 1;
        continue;
      }
      if (isActiveWriterError(error)) {
        result.deferred[session.provider] += 1;
        console.info(
          `[paseo-auto-sync] Deferred ${session.provider} session ${session.sessionId}: active writer`,
        );
        continue;
      }
      result.failed[session.provider] += 1;
      console.error(
        `[paseo-auto-sync] Failed to import ${session.provider} session ${session.sessionId}: ${errorMessage(error)}`,
      );
    }
  }

  return result;
}

async function discoverCodexSessions(root: string, signal?: AbortSignal) {
  const files = await walkFiles(root, JSONL_EXTENSION);
  const sessions: LocalSession[] = [];
  let skippedInvalid = 0;

  for (const file of files) {
    throwIfAborted(signal);
    try {
      const firstLine = await readFirstLine(file);
      const parsed = JSON.parse(firstLine) as {
        type?: unknown;
        payload?: {
          session_id?: unknown;
          id?: unknown;
          cwd?: unknown;
          source?: unknown;
          originator?: unknown;
        };
      };
      const sessionId = parsed.payload?.session_id ?? parsed.payload?.id;
      const source = parsed.payload?.source;
      const originator = parsed.payload?.originator;

      // exec 与 subagent 是一次性内部任务，导入后只会污染用户的主会话列表。
      if (
        parsed.type !== "session_meta" ||
        source === "exec" ||
        (source !== null && typeof source === "object") ||
        originator === "codex_exec" ||
        typeof sessionId !== "string" ||
        typeof parsed.payload?.cwd !== "string" ||
        !(await isDirectory(parsed.payload.cwd))
      ) {
        skippedInvalid += 1;
        continue;
      }

      sessions.push({
        provider: "codex",
        providerHandleId: sessionId,
        sessionId,
        cwd: parsed.payload.cwd,
        sourcePath: file,
        modifiedAt: (await stat(file)).mtimeMs,
      });
    } catch {
      skippedInvalid += 1;
    }
  }

  return { sessions, skippedInvalid };
}

async function discoverPiSessions(root: string, signal?: AbortSignal) {
  const files = await walkFiles(root, JSONL_EXTENSION);
  const sessions: LocalSession[] = [];
  let skippedInvalid = 0;

  for (const file of files) {
    throwIfAborted(signal);
    if (PI_INTERNAL_SESSION_PATH.test(file)) {
      skippedInvalid += 1;
      continue;
    }

    try {
      const parsed = JSON.parse(await readFirstLine(file)) as {
        type?: unknown;
        id?: unknown;
        cwd?: unknown;
      };
      if (
        parsed.type !== "session" ||
        typeof parsed.id !== "string" ||
        typeof parsed.cwd !== "string" ||
        !(await isDirectory(parsed.cwd))
      ) {
        skippedInvalid += 1;
        continue;
      }

      sessions.push({
        provider: "pi",
        providerHandleId: path.resolve(file),
        sessionId: parsed.id,
        cwd: parsed.cwd,
        sourcePath: file,
        modifiedAt: (await stat(file)).mtimeMs,
      });
    } catch {
      skippedInvalid += 1;
    }
  }

  return { sessions, skippedInvalid };
}

async function importWithPaseoCli(session: LocalSession, signal?: AbortSignal): Promise<void> {
  const paseo = await findPaseoCli();
  await execFileAsync(
    paseo,
    [
      "import",
      session.providerHandleId,
      "--provider",
      session.provider,
      "--cwd",
      session.cwd,
      "--label",
      AUTO_SYNC_LABEL,
      "--json",
    ],
    {
      signal,
      timeout: IMPORT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
}

async function findPaseoCli(): Promise<string> {
  const candidates = [
    process.env.PASEO_CLI,
    "paseo",
    path.join(homedir(), ".local", "bin", "paseo"),
    "/Applications/Paseo.app/Contents/Resources/bin/paseo",
    "/usr/lib/paseo/resources/bin/paseo",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate === "paseo") {
      return candidate;
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续检查下一处标准安装路径。
    }
  }

  throw new Error("Paseo CLI was not found");
}

async function walkFiles(root: string, extension: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(entryPath, extension);
      }
      return entry.isFile() && entry.name.endsWith(extension) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

async function readFirstLine(file: string): Promise<string> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      return line;
    }
    return "";
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function resolveConfiguredPath(value: string | undefined, fallback: string, homeDir: string): string {
  if (!value?.trim()) {
    return fallback;
  }
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return path.resolve(value);
}

function sessionKey(provider: Provider, handle: string): string {
  return `${provider}\0${handle}`;
}

function createEmptyResult(skippedInvalid: Record<Provider, number>): SyncResult {
  return {
    discovered: { codex: 0, pi: 0 },
    imported: { codex: 0, pi: 0 },
    skippedRegistered: { codex: 0, pi: 0 },
    skippedInvalid,
    deferred: { codex: 0, pi: 0 },
    remaining: { codex: 0, pi: 0 },
    failed: { codex: 0, pi: 0 },
  };
}

function isAlreadyImportedError(error: unknown): boolean {
  return errorMessage(error).includes("already imported");
}

function isActiveWriterError(error: unknown): boolean {
  return errorMessage(error).includes("already has an active writer");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveBatchSize(explicit: number | undefined, configured: string | undefined): number {
  const value = explicit ?? Number(configured);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_IMPORT_BATCH_SIZE;
  }
  return Math.min(Math.floor(value), MAX_IMPORT_BATCH_SIZE);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Session sync aborted");
  }
}
