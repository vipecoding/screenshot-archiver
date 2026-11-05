# Handover Plan: `@matty/screenshot-archiver`

## Current State (Completed & Verified)

1. **Behavior Extension (`extensions/behaviors/screenshot_archiver.ts`):**
   - Type: `@matty/screenshot-archiver`, version `2026.11.04.1`
   - Collective: `@matty` (`swamp auth whoami --json` verified)
   - Matches macOS screenshots (`Screenshot YYYY-MM-DD at ...` with `.png`, `.jpg`, `.pdf`, `.tiff`, `.gif`, `.heic`) and screen recordings (`Screen Recording YYYY-MM-DD at ...` with `.mov`).
   - Verifies macOS extended attributes (`com.apple.metadata:kMDItemIsScreenCapture` and `com.apple.metadata:kMDItemIsScreenRecording`) via batched `xattr` inspection.
   - Normalizes Thai Buddhist calendar years (`year > referenceYear + 500` → `year - 543`, e.g. `2569 → 2026`).
   - Supports configurable Obsidian-style `dateFormat` (default `"YYYY/MM/DD"`, tokens `YYYY`, `YY`, `MM`, `DD`).
   - Two-step verified archive:
     1. Content-hash deduplication (`resolveDestinationWithDeduplication`): if `destDir/<filename>` already exists with the same byte size, `rsync --dry-run --checksum`, and SHA-256 hash, skips copying (no ` (1)` duplicate created) and removes the redundant source file. If content differs, appends ` (1)`.
     2. Copies via `rsync -a`, verifies via `rsync --dry-run --checksum --itemize-changes` AND Web Crypto SHA-256 hash comparison (`sourceSha256 === destSha256`), and deletes the source file only after verification succeeds.
2. **Unit & Integration Tests (`extensions/behaviors/screenshot_archiver_test.ts`):**
   - 6 / 6 tests passing (`~/.swamp/deno/deno test --allow-read --allow-write --allow-run=rsync,xattr extensions/behaviors/screenshot_archiver_test.ts`).
3. **Behavior Instance (`models/@matty/screenshot-archiver/screenshot-archiver.yaml`):**
   - Name: `screenshot-archiver` (ID `78032a90-ba3b-4834-8cbf-2a35d77c184c`)
   - Configured for `sourceDir: /Users/matthew/Desktop` and `destRoot: /Users/matthew/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal/Daily`.
   - Validated (`swamp behavior validate screenshot-archiver --json`).
4. **Swamp Workflow (`workflows/workflow-archive-screenshots.yaml`):**
   - Name: `archive-screenshots` (ID `bbfe2ba0-32b0-495f-bc01-47086d38a072`)
   - Runs `scan` → `archive` on `screenshot-archiver`.
   - Validated and tested (`swamp workflow run archive-screenshots`).
5. **Historical Backlog Archived:**
   - All 1,257 historical screenshots/recordings across `~/Desktop`, `~/Desktop/Screenshots/Copied`, and `~/Desktop/Screenshots` have been archived and SHA-256 verified into Obsidian `Daily/YYYY/MM/DD` with 0 errors.

---

## Remaining Tasks (In Order)

### Phase 1: Rename Folder, Repair Swamp Bundles, & Push to GitHub

- **Matthew (Manual before starting new session):**
  1. Close this session and rename the directory:
     ```bash
     mv /Users/matthew/Repositories/vipecoding/swamp-getting-started \
        /Users/matthew/Repositories/vipecoding/screenshot-archiver
     cd /Users/matthew/Repositories/vipecoding/screenshot-archiver
     ```
  2. Start the new coding session inside `/Users/matthew/Repositories/vipecoding/screenshot-archiver`.

- **LLM (In new session):**
  1. Load the `swamp` skill.
  2. Run `swamp doctor extensions --repair` and `swamp behavior validate screenshot-archiver --json` + `swamp workflow validate archive-screenshots --json` so any cached absolute paths in `.swamp/` are refreshed for the new directory name.
  3. Initialize Git (`git init`), verify `.gitignore` (ensure `.swamp/` runtime state is properly ignored as configured by `swamp repo init`), create the initial commit, and create/push the GitHub repository `screenshot-archiver` via `gh repo create`.

### Phase 2: Package & Publish `@matty/screenshot-archiver` to Swamp Club Registry

- **LLM:**
  1. Load the `swamp` skill (`references/extension/guide.md` and `references/extension-publish/guide.md`).
  2. Remove personal hardcoded `/Users/matthew/...` defaults from `GlobalArgsSchema` in `extensions/behaviors/screenshot_archiver.ts` (keep Matthew's personal paths in `models/@matty/screenshot-archiver/screenshot-archiver.yaml` so the published extension has clean, secret/PII-safe docs and schema defaults).
  3. Add JSDoc comments, `README.md`, `LICENSE` (MIT), and `manifest.yaml` (including the new GitHub `repository:` URL).
  4. Run the full Swamp extension publish state machine:
     - `~/.swamp/deno/deno test --allow-read --allow-write --allow-run=rsync,xattr extensions/behaviors/screenshot_archiver_test.ts`
     - `swamp extension fmt manifest.yaml --check`
     - `swamp extension quality manifest.yaml --isolated --json`
     - Complete the Adversarial Review Gate (`swamp extension push manifest.yaml --dry-run`)
     - Publish with `swamp extension push manifest.yaml --json`
  5. Commit and push the manifest/README updates to GitHub.

### Phase 3: Enable the Nightly 03:15 AM macOS `launchd` Schedule

- **LLM:**
  1. Inspect the previous runner setup in `/Users/matthew/Repositories/mattvick/screenshot-archiver` (`runner/ScreenshotArchiverRunner.applescript`, `bin/build_runner_app.sh`, and `launchd/com.matthew.screenshot-archiver.plist`).
  2. Bring `runner/` and `launchd/` into `/Users/matthew/Repositories/vipecoding/screenshot-archiver` and update `ScreenshotArchiverRunner.applescript` so it runs `swamp workflow run archive-screenshots` in `/Users/matthew/Repositories/vipecoding/screenshot-archiver` (ensuring `PATH` includes the location of `swamp` and `/usr/bin/rsync`).
  3. Rebuild `/Applications/ScreenshotArchiverRunner.app` via `osacompile`.
  4. Install `~/Library/LaunchAgents/com.matthew.screenshot-archiver.plist` (scheduled for `03:15` via `StartCalendarInterval`), bootstrap and enable it in `launchctl gui/$(id -u)`.

- **Matthew (Manual check):**
  1. Open `System Settings → Privacy & Security → Full Disk Access` and confirm `/Applications/ScreenshotArchiverRunner.app` is toggled ON (re-toggle if rebuilding the `.app` bundle requires re-authorizing).
  2. LLM will then run `launchctl kickstart -k gui/$(id -u)/com.matthew.screenshot-archiver` and verify in `swamp workflow history search --json` that the background `launchd` run succeeded and scanned `~/Desktop` (`scannedCount > 0`).
