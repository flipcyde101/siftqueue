# siftqueue

Local SQLite-backed batch queue for triaging, cloning, and tracking GitHub issue fixes.

Built with Node 24 ESM and zero runtime dependencies (`node:sqlite`, `gh`, `git`, `node:test`).

## Requirements

- Node.js `>=24.0.0`
- GitHub CLI (`gh`) and `git` on `PATH` for `prepare` / `--clone`

## Usage

Initialize a batch from an issues file (one GitHub issue URL or `owner/repo#num` per line):

```powershell
siftqueue init s4 .\issues.txt --projects-dir D:\Codex\Projects
```

Check queue status:

```powershell
siftqueue status s4
```

Get the next actionable item with target workspace, shared `D:` cache env vars, and agent task packet:

```powershell
siftqueue next s4 --json
```

Prepare an item (fetch issue metadata via `gh issue view`, write `.siftqueue-issue.json` and `.siftqueue-brief.md`, and optionally clone):

```powershell
siftqueue prepare s4-01-myrepo-42 --clone
```

Update status, PR URL, or notes:

```powershell
siftqueue update s4-01-myrepo-42 --status PR_OPENED --pr https://github.com/owner/myrepo/pull/99 --note "Fixed edge case"
```

## Status Lifecycle

`QUEUED` -> `CLONED` -> `REPRODUCED` -> `FIXED` -> `VERIFIED` -> `PR_OPENED` (or `SKIPPED`)

## Configuration

- `SIFTQUEUE_DB` or `--db <path>`: SQLite database path (default: `~/.siftqueue/siftqueue.db`, WAL mode).
- `--projects-dir <dir>`: Base directory for cloned workspaces and `.cache` (default: `D:\Codex\Projects`).

## Testing

```powershell
node --test
```
