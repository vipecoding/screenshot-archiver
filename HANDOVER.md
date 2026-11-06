# Handover Plan: Standalone `screenshot-archiver` CLI & Nightly `launchd` Service

## Background & Goal

PR #1 has been merged to `main`. The core screenshot-archiving logic (`inspectAndProcess` in `extensions/behaviors/screenshot_archiver.ts`) and its 9 automated tests (`extensions/behaviors/screenshot_archiver_test.ts`) are complete and verified.

**Architectural Pivot (Agreed with User):**
- The user wants a **standalone macOS CLI tool** executed every night at **03:15 AM by `launchd`** (via `/Applications/ScreenshotArchiverRunner.app` for macOS Full Disk Access), **not** a Swamp Club extension and **not** using Deno (which is being deprecated).
- All Swamp scaffolding (`.swamp/`, `.swamp.yaml`, `manifest.yaml`, `quality.yaml`, `models/`, `workflows/`, `vaults/`, `.opencode/plugins/swamp-audit.ts`, and the Swamp managed section in `AGENTS.md`) should be removed.
- The tool should be written in **zero-dependency, portable TypeScript using standard `node:fs/promises`, `node:path`, and `node:child_process` APIs** (runnable natively in both Node.js 24+ and Bun) and compiled into a single standalone macOS arm64 executable (`bin/screenshot-archiver`) via `bun build --compile`.

---

## Target Architecture (To Implement in Next Session)

### 1. Runtime & Project Layout
```text
screenshot-archiver/
├── bin/
│   ├── build_runner_app.sh          # Builds /Applications/ScreenshotArchiverRunner.app
│   ├── diagnose_agent.sh            # Checks launchd status, FDA, rsync capabilities, and recent logs
│   └── screenshot-archiver          # Compiled standalone binary (gitignored, built via bun build --compile)
├── launchd/
│   └── com.matthew.screenshot-archiver.plist
├── logs/                            # Gitignored local runtime logs (archive.log + audit.jsonl)
├── runner/
│   └── ScreenshotArchiverRunner.applescript
├── src/
│   ├── archiver.ts                  # Core archiver engine (node:fs/promises, node:path, node:child_process)
│   ├── audit.ts                     # Human-readable log (archive.log) + JSONL audit trail (audit.jsonl) + rotation
│   └── cli.ts                       # CLI entrypoint (scan, archive, dry-run, history)
├── test/
│   └── archiver.test.ts             # Automated test suite (runs via `bun test`)
├── package.json                     # Scripts: build, test, start, install-agent
├── tsconfig.json
├── LICENSE
└── README.md
```

### 2. Batching & Concurrency Design
- Process eligible files in **configurable chunks/batches** (default `batchSize = 50`) with **modest bounded concurrency** (default `concurrency = 4`, configurable via `--concurrency` / `--batch-size`).
- Within each batch:
  1. Ensure target `YYYY/MM/DD` directories exist once per unique date folder (`Set<string>` cache) rather than calling `mkdir` redundantly for every file.
  2. Copy and checksum-verify up to `concurrency` (4) files in parallel using `rsync -aXN` + `rsync --dry-run -aXN --checksum --itemize-changes`.
  3. Batch-verify destination extended attributes (`xattr -- ...`) across the batch (1 subprocess call per batch instead of 1 per file), then delete verified source files.
  4. Flush the batch's results immediately to the audit log (`logs/audit.jsonl` and `logs/archive.log`) so even if a 1,000-file backlog run is interrupted mid-way, every completed batch is permanently recorded in the audit trail.

### 3. Nightly Audit Trail (`src/audit.ts`)
- **Human-Readable Log (`logs/archive.log`):**
  - Appends a clean, timestamped summary header and per-file lines (`ARCHIVED`, `DEDUPLICATED`, `ERROR`) for each run/batch.
  - Auto-rotates (`archive.log.1`) when file size exceeds 5 MB.
- **Structured JSONL Log (`logs/audit.jsonl`):**
  - Appends one JSON line per run/batch with full metadata (run ID, timestamps, counts, and per-file source/dest paths, sizes, and errors).
  - Auto-rotates (`audit.jsonl.1`) when file size exceeds 10 MB.
- **Built-in CLI History Viewer (`screenshot-archiver history`):**
  - Displays recent runs and moved/failed files from `logs/audit.jsonl` (supports `--errors` and `--limit N`).
- **macOS Notification on Error:**
  - When `errorCount > 0` or `destRoot` is unavailable during an archive run, triggers a best-effort macOS Notification Center alert via `osascript` so a 3:15 AM failure is immediately visible.

### 4. `launchd` & `ScreenshotArchiverRunner.app` Integration
- Bring in `runner/ScreenshotArchiverRunner.applescript`, `bin/build_runner_app.sh`, `bin/diagnose_agent.sh`, and `launchd/com.matthew.screenshot-archiver.plist` (referencing `/Users/matthew/Repositories/mattvick/screenshot-archiver` as the template).
- Update `ScreenshotArchiverRunner.applescript` to execute `/Users/matthew/Repositories/vipecoding/screenshot-archiver/bin/screenshot-archiver archive`.
- Rebuild `/Applications/ScreenshotArchiverRunner.app`, install `~/Library/LaunchAgents/com.matthew.screenshot-archiver.plist` (03:15 AM schedule), bootstrap/enable in `launchctl gui/$(id -u)`, verify Full Disk Access, and test with `launchctl kickstart -k`.
