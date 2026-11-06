# Project: `screenshot-archiver`

Standalone, zero-dependency TypeScript macOS CLI tool compiled to a native binary (`bin/screenshot-archiver`) via `bun build --compile` and scheduled at 03:15 AM via macOS `launchd` (`/Applications/ScreenshotArchiverRunner.app`).

## Architecture & Rules

1. **Zero external runtime dependencies.** Use only standard `node:fs/promises`, `node:path`, `node:child_process`, `node:crypto`, and `node:util` APIs so `src/` runs natively in both Bun and Node.js 24+.
2. **Verified two-step transfer (`rsync -aXN` + `--checksum` + `xattr`).** Every screenshot (`com.apple.metadata:kMDItemIsScreenCapture`) and screen recording (`com.apple.metadata:kMDItemIsScreenRecording`) is verified via extended attributes before and after transfer, and source files are only deleted after `rsync --dry-run -aN --checksum --itemize-changes` and `xattr` verification succeed.
3. **Day-by-day planning & bounded concurrency.** Group eligible files by date (`YYYY-MM-DD`) via `createArchivePlan`, sub-batching only when a day exceeds `batchSize = 50`, processing up to `concurrency = 4` files in parallel per batch, deduplicating `mkdir` per day, and flushing audit logs (`logs/archive.log` and `logs/audit.jsonl`) after every batch.
4. **Build & Test.**
   - Run tests: `bun test`
   - Compile binary: `bun run build` (`bun build --compile src/cli.ts --outfile bin/screenshot-archiver`)
   - Build macOS Runner App: `bash bin/build_runner_app.sh`
   - Diagnose `launchd` agent: `bash bin/diagnose_agent.sh`
