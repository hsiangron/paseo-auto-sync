# paseo-auto-sync

[中文](README.zh-CN.md)

Paseo v0.8 plugin that imports local Codex and Pi sessions whenever the Paseo
client loads. It follows Gaseo's link-not-copy model: original JSONL transcripts
remain in their provider directories, while Paseo stores the provider session
handle needed to resume them.

## Behavior

- Syncs once when the server plugin starts and again when a Paseo client loads.
- Concurrent triggers from multiple windows are merged into a single in-flight
  sync.
- Uses `paseo import`, so provider history and resume behavior stay owned by
  Paseo.
- Treats active and archived Paseo agents as registered, so archived sessions
  are not recreated on the next launch.
- Imports main sessions only. Codex `exec` / subagent records and Pi `forks` or
  `run-*/session.jsonl` files are skipped.
- Skips sessions whose original working directory no longer exists on this host.
- Codex sessions that currently have an active writer are deferred and retried
  on the next sync.
- Labels agents created by the plugin with `paseo-auto-sync=true`.
- Adds **Sync local Codex and Pi sessions** in the Command Center for a manual
  retry.

## Resource limits

Every imported session can keep a provider runtime alive until the Paseo daemon
unloads it. To avoid starting dozens of `codex app-server` processes on first
install, each sync imports at most **3** new sessions by default, newest first.
Remaining sessions are imported on later launches or a Command Center retry.

Set `PASEO_AUTO_SYNC_BATCH_SIZE` to a value from `1` to `50` to change the
batch size.

After a large first-time import, `paseo daemon restart` releases those runtimes
without deleting the imported agent records. Do not restart while other agents
are still working.

## Install

```bash
git clone https://github.com/hsiangron/paseo-auto-sync.git
cd paseo-auto-sync
npm install
paseo plugin install /absolute/path/to/paseo-auto-sync
```

Reload the plugin after local edits:

```bash
paseo plugin reload paseo-auto-sync
```

## Configuration

The plugin reads these environment variables. Unset values use the defaults
below.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex home; sessions are read from `$CODEX_HOME/sessions` |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent directory |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Pi session JSONL root |
| `PASEO_HOME` | `~/.paseo` | Paseo data directory used for active/archived dedupe |
| `PASEO_CLI` | `paseo` on `PATH`, then common install locations | CLI used for `paseo import` |
| `PASEO_AUTO_SYNC_BATCH_SIZE` | `3` (`1`–`50`) | Max new sessions imported per sync |

## Development

```bash
npm install
npm test
npm run typecheck
```
