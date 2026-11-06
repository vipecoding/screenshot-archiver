# Plan 1: TypeScript CLI Refactor (Day-by-Day Planner + `com.apple.screencapture`) & PR Review Handover

## 1. Scope of Phase 1 (`vipecoding/screenshot-archiver`)

This repository has been converted from a Swamp/Deno extension into a standalone, zero-dependency TypeScript macOS CLI compiled via `bun build --compile` to `bin/screenshot-archiver` and scheduled at 03:15 AM via `launchd` (`/Applications/ScreenshotArchiverRunner.app`).

In this refactor pass, we add three major architectural improvements to the TypeScript CLI before opening the Pull Request:

### A. Auto-Detecting macOS Screenshot Settings (`com.apple.screencapture`)
macOS stores user screenshot preferences in `~/Library/Preferences/com.apple.screencapture.plist` (queried via `/usr/bin/defaults read com.apple.screencapture <key>`):
- **`location`**: Custom directory where macOS saves screenshots and screen recordings (configured in `Cmd+Shift+5` → Options). If unset or empty, macOS defaults to `~/Desktop`.
- **`name`**: Custom filename prefix for screenshots (defaults to `"Screenshot"` when unset).

**Resolution Precedence:**
1. Explicit CLI flag (`--source-dir <path>` / `--screenshot-prefix <prefix>`) or programmatic override in `GlobalArgs` / `InspectAndProcessOptions`.
2. Auto-detected `com.apple.screencapture` value (`detectMacOSScreenshotSettings()`).
3. Built-in defaults (`~/Desktop` and `"Screenshot"`).

### B. Explicit Per-Kind Filename + Extension Regexes
Instead of a partial regex that ignores extensions plus separate `startsWith` and `Set` checks, `parseScreenshotFilename` uses explicit, self-contained regexes per capture type:
- **Screenshot Pattern:**
  `^<escapedScreenshotPrefix>\s+(\d{4}-\d{2}-\d{2})\s+at\s+.+\.(png|jpe?g|pdf|tiff?|gif|heic)$` (case-insensitive extension matching, where `<escapedScreenshotPrefix>` defaults to `Screenshot` or the configured custom prefix from `com.apple.screencapture`).
- **Screen Recording Pattern:**
  `^Screen Recording\s+(\d{4}-\d{2}-\d{2})\s+at\s+.+\.mov$` (case-insensitive `.mov` matching).
- Files that start with `<screenshotPrefix> ` (+ valid image extension) or `Screen Recording ` (+ `.mov` extension) but have an unparseable or invalid calendar date still return `{ matchedPrefix: true }` without `fileDate` so `skippedUnparseableCount` is accurately tracked, while impossible combinations like `Screen Recording 2026-11-05 at 10.00.00.jpg` or `Screenshot notes.txt` return `{ matchedPrefix: false }`.

### C. "Discover → Plan by Day → Execute" (`createArchivePlan`)
Instead of flattening all eligible files across all dates and slicing them into arbitrary 50-file chunks that cut across different days, `inspectAndProcess` now works in three explicit phases:

1. **Phase 1 — Discover:**
   - Scan `sourceDir`, parse filenames, batch-inspect extended attributes (`com.apple.metadata:kMDItemIsScreenCapture` / `com.apple.metadata:kMDItemIsScreenRecording`), detect APFS/iCloud dataless files (`sizeBytes > 0 && statInfo.blocks === 0`), and separate `skipped-today` files from eligible candidates.
2. **Phase 2 — Build Day-by-Day Execution Plan (`createArchivePlan`):**
   - Group eligible candidates by `fileDate` (`YYYY-MM-DD`) in chronological order (`DayPlan[]`).
   - Within each `DayPlan`:
     - If the day has `<= batchSize` (default `50`) files, that entire day is **1 batch**.
     - Only if a single day has `> batchSize` files do we split that day into sub-batches of `batchSize`.
   - Record `dayCount` and `batchCount` in `SummaryResource` and `AuditRunRecord`.
3. **Phase 3 — Execute Plan Day-by-Day:**
   - **Single `mkdir` per day:** Ensure `<destRoot>/<dateSubpath>` exists once per `DayPlan`.
   - **Pre-inspect destination directory once per day-batch:** Read existing entries in `destDir`.
   - **Fast Multi-File `rsync` Path (No Filename Collisions in `destDir`):**
     - When none of the files in the day-batch collide with existing files in `destDir` (and no per-file `beforeVerify` test hook is active), execute:
       1. **One multi-source `rsync` copy call** for the entire day-batch:
          `rsync -aXN -- <src1> <src2> ... <destDir>/`
       2. **One multi-file `xattr` check** across all copied destination files in the batch (`getExtendedAttributesMap(destPaths)`).
       3. Parallel `stat` + `rsync --dry-run -aN --checksum --itemize-changes` verification (bounded by `concurrency = 4`), then unlink verified source files.
     - If the batch-level `rsync` copy fails or if any file in the batch has an existing filename in `destDir` (requiring deduplication or ` (1)` collision suffix), seamlessly fall back to the per-file bounded-concurrency (`concurrency = 4`) handler so every file is handled or isolated safely.
   - **Per-Batch Audit Flush:**
     - Flush each completed day-batch immediately to `logs/archive.log` and `logs/audit.jsonl` (with `fileDate` / day context).

---

## 2. Verification Checklist for Phase 1

- [ ] `bun test` passes all unit and integration tests (including new tests for `com.apple.screencapture` `location` + `name` detection, explicit filename/extension regex edge cases like `Screen Recording ... .jpg`, and `createArchivePlan` day-by-day grouping + sub-batching when a day has `> batchSize` files).
- [ ] `bun run build` compiles `bin/screenshot-archiver` cleanly.
- [ ] `./bin/screenshot-archiver scan --verbose` and `./bin/screenshot-archiver history` work end-to-end.
- [ ] Feature branch pushed to `origin` and GitHub Pull Request opened.

---

## 3. Handover Prompt for Session 2 (PR Review & Merge)

Copy and paste the prompt below into a fresh session to review and merge the Pull Request:

```markdown
We have opened a Pull Request in `/Users/matthew/Repositories/vipecoding/screenshot-archiver` that converts the repository from a Swamp/Deno extension into a standalone, zero-dependency TypeScript macOS CLI (`bin/screenshot-archiver`) scheduled at 03:15 AM via `launchd` (`/Applications/ScreenshotArchiverRunner.app`), and implements:
1. Auto-detection of macOS screenshot `location` and custom filename prefix (`name`) via `com.apple.screencapture`.
2. Explicit per-kind filename + extension regexes (`Screenshot` + image extensions vs. `Screen Recording` + `.mov`).
3. A day-by-day execution planner (`createArchivePlan`) that groups eligible files by date (`YYYY-MM-DD`), only sub-batches within a day when that day exceeds `batchSize` (50), uses a single multi-source `rsync -aXN` call per collision-free day-batch, and flushes audit logs (`logs/archive.log` and `logs/audit.jsonl` with 50 MB rotation) after each batch.

Please perform a thorough code review of the open PR:
1. Inspect the PR diff with `gh pr view` and `gh pr diff`.
2. Check for any edge cases, race conditions, security/path-traversal issues, or regressions in `src/archiver.ts`, `src/audit.ts`, `src/cli.ts`, `test/archiver.test.ts`, `bin/`, `runner/`, and `launchd/`.
3. Run `bun test` and `bun run build` and verify the compiled `./bin/screenshot-archiver` binary.
4. Note: Keep `plans/02-swift-macos-app-plan.md` intact (or let me know before removing `plans/`) so we can use it for the upcoming native Swift macOS app repository.
5. If everything is clean and verified, approve/merge the PR to `main` and sync the local `main` branch.
```
