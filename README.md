# paseo-auto-sync

[中文](README.zh-CN.md)

Paseo plugin that imports local Codex and Pi sessions and removes Paseo records
whose provider sessions no longer exist. It follows Gaseo's link-not-copy model:
original JSONL transcripts remain in their provider directories, while Paseo
stores the provider session handle needed to resume them.

## Behavior

- Syncs when the server plugin starts, when a Paseo client loads, and every 24
  hours while the daemon stays running.
- Hard-deletes idle or closed Paseo agents when their Pi/Codex native session no
  longer exists. Running agents are never deleted.
- Archives a workspace only when cleanup successfully deletes every agent it
  contained, so shared workspaces remain active.
- Concurrent triggers from multiple windows are merged into a single in-flight
  sync.
- Creates one Paseo workspace per imported session so it appears in the
  sidebar. A bare `paseo import` would place every session into the oldest
  workspace for that folder.
- Treats active and archived Paseo agents as registered, so archived sessions
  are not recreated on the next launch.
- Imports main sessions from `~/.codex/sessions` and `~/.codex/archived_sessions`.
  Codex `exec` / subagent records and Pi `forks` or `run-*/session.jsonl` files
  are skipped.
- Skips sessions whose original working directory no longer exists on this host.
- Codex sessions that currently have an active writer are deferred and retried
  on the next sync.
- Labels agents created by the plugin with `paseo-auto-sync=true`.
- Adds **Sync local Codex and Pi sessions** in the Command Center for a manual
  retry.

## Resource limits

Every imported session can keep a provider runtime alive until the Paseo daemon
unloads it. To avoid starting dozens of `codex app-server` processes on first
install, each sync imports at most **50** new sessions by default, newest first.
Remaining sessions are imported on later launches or a Command Center retry.

Set `PASEO_AUTO_SYNC_BATCH_SIZE` to a value from `1` to `50` to change the
batch size.

After a large first-time import, `paseo daemon restart` releases those runtimes
without deleting the imported agent records. Do not restart while other agents
are still working.

## Install

Keep the plugin inside the Paseo home, not as a sibling checkout in `$HOME`:

```bash
git clone https://github.com/hsiangron/paseo-auto-sync.git ~/.paseo/plugins/paseo-auto-sync
cd ~/.paseo/plugins/paseo-auto-sync
npm install
paseo plugin install ~/.paseo/plugins/paseo-auto-sync
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
| `CODEX_HOME` | `~/.codex` | Codex home; sessions are read from `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions` |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent directory |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Pi session JSONL root |
| `PASEO_HOME` | `~/.paseo` | Paseo data directory used for active/archived dedupe |
| `PASEO_CLI` | `paseo` on `PATH`, then common install locations | CLI used to import sessions and remove dangling Paseo records |
| `PASEO_AUTO_SYNC_BATCH_SIZE` | `50` (`1`–`50`) | Max new sessions imported per sync |
| `PASEO_AUTO_SYNC_INTERVAL_HOURS` | `24` (`1`–`168`) | Interval for periodic sync and dangling-session cleanup |

## Development

```bash
npm install
npm test
npm run typecheck
```
