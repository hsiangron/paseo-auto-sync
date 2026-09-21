import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const payloadRaw = process.env.PASEO_IMPORT_JSON;
if (!payloadRaw) {
  throw new Error("PASEO_IMPORT_JSON is required");
}
let payload;
try {
  payload = JSON.parse(payloadRaw);
} catch {
  throw new Error("PASEO_IMPORT_JSON is not valid JSON");
}

function resolvePaseoBin() {
  const which = spawnSync("which", ["paseo"], {
    encoding: "utf8",
  }).stdout?.trim();
  const candidates = [
    process.env.PASEO_CLI,
    which,
    join(homedir(), ".local", "bin", "paseo"),
    "/Applications/Paseo.app/Contents/Resources/bin/paseo",
    "/usr/bin/paseo",
    "/usr/lib/paseo/resources/bin/paseo",
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate === "paseo") {
      continue;
    }
    try {
      if (existsSync(candidate)) {
        return realpathSync(candidate);
      }
    } catch {
      // 继续尝试下一处安装路径。
    }
  }
  throw new Error("Paseo CLI was not found");
}

function resolveCliUtilsDir(bin) {
  const candidates = [
    join(dirname(bin), "../dist/utils"),
    join(
      dirname(bin),
      "../app.asar/node_modules/@getpaseo/cli/dist/utils",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "client.js"))) {
      return candidate;
    }
  }
  throw new Error("Paseo CLI runtime modules were not found");
}

const bin = resolvePaseoBin();
const utilsDir = resolveCliUtilsDir(bin);
const { connectToDaemon } = await import(
  pathToFileURL(join(utilsDir, "client.js")).href,
);
const { selectDaemonTarget } = await import(
  pathToFileURL(join(utilsDir, "daemon-target.js")).href,
);
// Paseo 0.9+ 要求显式 target；空对象会在 buildDaemonConnectionCommandError 里读 options.target.kind 崩溃。
const client = await connectToDaemon({ target: selectDaemonTarget({}) });
try {
  const agent = await client.importAgent({
    provider: payload.provider,
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    workspaceId: payload.workspaceId,
    labels: payload.labels,
  });
  process.stdout.write(
    `${JSON.stringify({
      agentId: agent.id,
      title: agent.title ?? null,
      workspaceId: agent.workspaceId ?? payload.workspaceId,
    })}\n`,
  );
} finally {
  await client.close().catch(() => undefined);
}
