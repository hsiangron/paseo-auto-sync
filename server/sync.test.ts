import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverLocalSessions, readRegisteredSessionKeys, syncLocalSessions } from "./sync";

test("discovers main Codex and Pi sessions while excluding internal sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-auto-sync-"));
  try {
    const cwd = path.join(root, "workspace");
    const codexSessions = path.join(root, ".codex", "sessions", "2026", "09", "14");
    const piSessions = path.join(root, ".pi", "agent", "sessions", "project");
    await Promise.all([mkdir(cwd), mkdir(codexSessions, { recursive: true }), mkdir(piSessions, { recursive: true })]);

    await writeJsonl(path.join(codexSessions, "main.jsonl"), {
      type: "session_meta",
      payload: { session_id: "codex-main", cwd, source: "vscode", originator: "codex_cli_rs" },
    });
    await writeJsonl(path.join(codexSessions, "exec.jsonl"), {
      type: "session_meta",
      payload: { session_id: "codex-exec", cwd, source: "exec", originator: "codex_exec" },
    });
    await writeJsonl(path.join(piSessions, "main.jsonl"), {
      type: "session",
      version: 3,
      id: "pi-main",
      cwd,
    });
    await mkdir(path.join(piSessions, "forks"));
    await writeJsonl(path.join(piSessions, "forks", "fork.jsonl"), {
      type: "session",
      version: 3,
      id: "pi-fork",
      cwd,
    });

    const result = await discoverLocalSessions({ homeDir: root, env: {} });

    assert.deepEqual(
      result.sessions.map(({ provider, sessionId }) => ({ provider, sessionId })).sort(bySessionId),
      [
        { provider: "codex", sessionId: "codex-main" },
        { provider: "pi", sessionId: "pi-main" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads active and archived Paseo persistence handles for deduplication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-auto-sync-"));
  try {
    const agents = path.join(root, "agents", "workspace");
    await mkdir(agents, { recursive: true });
    await writeFile(
      path.join(agents, "agent.json"),
      JSON.stringify({
        archivedAt: "2026-09-14T00:00:00.000Z",
        persistence: {
          provider: "pi",
          sessionId: "pi-session",
          nativeHandle: "/sessions/pi-session.jsonl",
        },
      }),
    );

    const keys = await readRegisteredSessionKeys(root);

    assert.equal(keys.has("pi\0pi-session"), true);
    assert.equal(keys.has("pi\0/sessions/pi-session.jsonl"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imports only unregistered sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-auto-sync-"));
  try {
    const cwd = path.join(root, "workspace");
    const codexSessions = path.join(root, ".codex", "sessions", "2026", "09", "14");
    const agents = path.join(root, ".paseo", "agents", "workspace");
    await Promise.all([
      mkdir(cwd),
      mkdir(codexSessions, { recursive: true }),
      mkdir(agents, { recursive: true }),
    ]);
    await writeJsonl(path.join(codexSessions, "existing.jsonl"), {
      type: "session_meta",
      payload: { session_id: "existing", cwd, source: "vscode", originator: "codex_cli_rs" },
    });
    await writeJsonl(path.join(codexSessions, "new.jsonl"), {
      type: "session_meta",
      payload: { session_id: "new", cwd, source: "vscode", originator: "codex_cli_rs" },
    });
    await writeFile(
      path.join(agents, "agent.json"),
      JSON.stringify({ persistence: { provider: "codex", sessionId: "existing" } }),
    );
    const imported: string[] = [];

    const result = await syncLocalSessions({
      homeDir: root,
      env: {},
      batchSize: 10,
      importSession: async (session) => {
        imported.push(session.sessionId);
      },
    });

    assert.deepEqual(imported, ["new"]);
    assert.equal(result.imported.codex, 1);
    assert.equal(result.skippedRegistered.codex, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("limits each sync batch and defers active Codex writers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-auto-sync-"));
  try {
    const cwd = path.join(root, "workspace");
    const codexSessions = path.join(root, ".codex", "sessions", "2026", "09", "14");
    await Promise.all([mkdir(cwd), mkdir(codexSessions, { recursive: true })]);
    for (const sessionId of ["one", "two", "three"]) {
      await writeJsonl(path.join(codexSessions, `${sessionId}.jsonl`), {
        type: "session_meta",
        payload: { session_id: sessionId, cwd, source: "vscode", originator: "codex_cli_rs" },
      });
    }
    let attempts = 0;

    const result = await syncLocalSessions({
      homeDir: root,
      env: {},
      batchSize: 2,
      importSession: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("thread already has an active writer");
        }
      },
    });

    assert.equal(attempts, 2);
    assert.equal(result.deferred.codex, 1);
    assert.equal(result.imported.codex, 1);
    assert.equal(result.remaining.codex, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeJsonl(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

function bySessionId(left: { sessionId: string }, right: { sessionId: string }): number {
  return left.sessionId.localeCompare(right.sessionId);
}
