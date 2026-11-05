# Handover Plan: `@matty/screenshot-archiver`

## Current State (Completed & Verified)

1. **Behavior Extension (`extensions/behaviors/screenshot_archiver.ts`):**
   - Type: `@matty/screenshot-archiver`, version `2026.11.05.1`
   - Collective: `@matty` (`swamp auth whoami --json` verified)
   - Matches macOS screenshots (`Screenshot YYYY-MM-DD at ...` with `.png`, `.jpg`, `.jpeg`, `.pdf`, `.tiff`, `.tif`, `.gif`, `.heic`) and screen recordings (`Screen Recording YYYY-MM-DD at ...` with `.mov`).
   - Verifies macOS extended attributes (`com.apple.metadata:kMDItemIsScreenCapture` and `com.apple.metadata:kMDItemIsScreenRecording`) via chunked `xattr` inspection.
   - Normalizes Thai Buddhist calendar years (`referenceYear + 500 <= year <= referenceYear + 545` → `year - 543`, e.g. `2569 → 2026`).
   - Supports configurable Obsidian-style `dateFormat` (default `"YYYY/MM/DD"`, tokens `YYYY`, `YY`, `MM`, `DD`) and leading `~/` tilde expansion in `sourceDir` and `destRoot`.
   - Two-step verified archive:
     1. Content-checksum deduplication (`resolveDestinationWithDeduplication`): if `destDir/<filename>` already exists with the same byte size and `rsync --dry-run --checksum`, skips copying (syncing any missing extended attributes or creation timestamps in place on the existing inode via `rsync -aXN --checksum` and re-verifying when needed) and removes the redundant source file. If content differs, appends ` (1)`.
     2. Copies via Homebrew `rsync -aXN` (preserving extended attributes `-X` and APFS creation timestamps `-N`), verifies via `rsync --dry-run -aXN --checksum --itemize-changes`, `xattr` presence, and `birthtime`, cleaning up any unverified destination copy on failure and deleting the source file only after verification succeeds.
2. **Unit & Integration Tests (`extensions/behaviors/screenshot_archiver_test.ts`):**
   - 9 / 9 tests passing (`~/.swamp/deno/deno test --allow-read --allow-write --allow-run=rsync,xattr extensions/behaviors/screenshot_archiver_test.ts`).
3. **Behavior Instance (`models/@matty/screenshot-archiver/screenshot-archiver.yaml`):**
   - Name: `screenshot-archiver` (ID `78032a90-ba3b-4834-8cbf-2a35d77c184c`)
   - Configured for `sourceDir: ~/Desktop` and `destRoot: ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal/Daily`.
   - Validated (`swamp behavior validate screenshot-archiver --json`).
4. **Swamp Workflow (`workflows/workflow-archive-screenshots.yaml`):**
   - Name: `archive-screenshots` (ID `bbfe2ba0-32b0-495f-bc01-47086d38a072`)
   - Runs `scan` → `archive` on `screenshot-archiver` with a CEL `guard` (`data.latest("screenshot-archiver", "main").attributes.eligibleCount == 0`) so `archive` is skipped when there are no eligible files.
   - Validated (`swamp workflow validate archive-screenshots --json`).
5. **Historical Backlog Archived:**
   - All 1,257 historical screenshots/recordings across `~/Desktop`, `~/Desktop/Screenshots/Copied`, and `~/Desktop/Screenshots` have been archived and SHA-256 verified into Obsidian `Daily/YYYY/MM/DD` with 0 errors.

---

## Remaining Tasks (In Order)

### Phase 1: Repository Setup & PR Review (Completed)

- Repository initialized and pushed to `https://github.com/vipecoding/screenshot-archiver`.
- PR #1 review findings addressed and verified.

### Phase 2: Package & Publish `@matty/screenshot-archiver` to Swamp Club Registry

1. Load the `swamp` skill (`references/extension/guide.md` and `references/extension-publish/guide.md`).
2. Run the Swamp extension publish state machine:
   - `~/.swamp/deno/deno test --allow-read --allow-write --allow-run=rsync,xattr extensions/behaviors/screenshot_archiver_test.ts`
   - `swamp extension fmt manifest.yaml --check`
   - `swamp extension quality manifest.yaml --isolated --json`
   - Complete the Adversarial Review Gate (`swamp extension push manifest.yaml --dry-run`)
   - Publish with `swamp extension push manifest.yaml --json` (after user confirmation)

### Phase 3: Enable the Nightly 03:15 AM macOS `launchd` Schedule

1. Inspect the runner setup (`runner/ScreenshotArchiverRunner.applescript`, `bin/build_runner_app.sh`, and `launchd/com.matthew.screenshot-archiver.plist`).
2. Update `ScreenshotArchiverRunner.applescript` so it runs `swamp workflow run archive-screenshots` in the repository directory (ensuring `PATH` includes Homebrew `/opt/homebrew/bin` ahead of `/usr/bin` so Homebrew `rsync` 3.x+ is used alongside `swamp`).
3. Rebuild `/Applications/ScreenshotArchiverRunner.app` via `osacompile`.
4. Install `~/Library/LaunchAgents/com.matthew.screenshot-archiver.plist` (scheduled for `03:15` via `StartCalendarInterval`), bootstrap and enable it in `launchctl gui/$(id -u)`.
5. Confirm `/Applications/ScreenshotArchiverRunner.app` is toggled ON in `System Settings → Privacy & Security → Full Disk Access`, then kickstart and verify via `swamp workflow history search --json`.
