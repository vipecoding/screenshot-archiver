# Handover Plan: Native Swift 6 macOS Menu Bar App (`ScreenshotArchiver.app`)

## 1. Background & Goal

We have a working, adversarially reviewed TypeScript reference implementation in `/Users/matthew/Repositories/vipecoding/screenshot-archiver` (`src/archiver.ts`, `src/audit.ts`, `src/cli.ts`, `test/archiver.test.ts`).

In `/Users/matthew/Repositories/vipecoding/screenshot-archiver-app`, we are building the **native Swift 6 macOS Menu Bar application (`ScreenshotArchiver.app`)** with **zero external dependencies**.

### Why Native Swift
- **Single ~500 KB `.app` bundle** (`/Applications/ScreenshotArchiver.app`) with a proper `CFBundleIdentifier` (`com.matthew.ScreenshotArchiver`), app name, and Menu Bar icon (`LSUIElement = true`).
- **Zero external dependencies:** Uses native Darwin `<copyfile.h>` (`copyfile` with `COPYFILE_ALL | COPYFILE_CLONE`), `<sys/xattr.h>` (`getxattr` / `listxattr`), `<sys/stat.h>` (`lstat` / `stat`), and Apple `CryptoKit` (`SHA256`)—eliminating Homebrew `rsync`, `/usr/bin/xattr` subprocesses, Bun, AppleScript (`osacompile`), and shell wrappers.
- **No Full Disk Access required:** Uses macOS **Security-Scoped Bookmarks** (`URL.bookmarkData(options: .withSecurityScope)`) granted when selecting the Source and Destination folders in `NSOpenPanel`.
- **Both Menu Bar UI & Headless CLI Mode:**
  - Launching `/Applications/ScreenshotArchiver.app` with no arguments starts the SwiftUI `MenuBarExtra` status bar app (with Settings window, "Scan", "Archive Now", daily 03:15 AM scheduler, and History viewer).
  - Running `/Applications/ScreenshotArchiver.app/Contents/MacOS/ScreenshotArchiver <scan|archive|dry-run|history> [options]` executes headless CLI mode (for scripts, terminal use, or `launchd`).

---

## 2. Core Domain & Safety Requirements (Must Match Reference Implementation)

Read `/Users/matthew/Repositories/vipecoding/screenshot-archiver/src/archiver.ts`, `src/audit.ts`, and `test/archiver.test.ts` before starting and ensure every single rule and edge case below is preserved:

1. **Auto-Detection of macOS Screenshot Settings (`com.apple.screencapture`):**
   - Read `UserDefaults(suiteName: "com.apple.screencapture")`:
     - `location`: custom screenshot save folder (defaults to `~/Desktop` when unset/empty).
     - `name`: custom screenshot filename prefix (defaults to `"Screenshot"` when unset/empty).
   - Allow user override in the app's Settings UI and via CLI flags (`--source-dir`, `--screenshot-prefix`).

2. **Strict Filename + Extension + Extended Attribute Matching:**
   - **Screenshots:** `^<escapedPrefix>\s+(\d{4}-\d{2}-\d{2})\s+at\s+.+\.(png|jpe?g|pdf|tiff?|gif|heic)$` (case-insensitive extension) AND must have extended attribute `com.apple.metadata:kMDItemIsScreenCapture`.
   - **Screen Recordings:** `^Screen Recording\s+(\d{4}-\d{2}-\d{2})\s+at\s+.+\.mov$` (case-insensitive extension) AND must have extended attribute `com.apple.metadata:kMDItemIsScreenRecording`.
   - **Unparseable Date Tracking:** Files matching `^<escapedPrefix>\s+.+\.(png|jpe?g|pdf|tiff?|gif|heic)$` or `^Screen Recording\s+.+\.mov$` that fail date parsing or calendar validation (`2026-02-30`, `Screenshot corrupted.png`) increment `skippedUnparseableCount`, while unrelated files (`Screenshot notes.txt`, `Screen Recording ... .jpg`) are ignored (`matchedPrefix: false`).
   - **Buddhist Era Calendar Normalization:** If the parsed 4-digit year falls in `[referenceYear + 500, referenceYear + 545]` (e.g., `2569` in `2026`), subtract `543` (`2026`).
   - **Dataless File Detection (APFS + iCloud FileProvider):** Inspect `st_size > 0 && st_blocks == 0` via Darwin `stat(2)`. Reading xattrs via `getxattr(2)` / `listxattr(2)` does not materialize dataless files. During `scan` and `dry-run`, **never** compute SHA-256 on a dataless source or destination file (`st_blocks == 0`) so read-only previews never trigger iCloud Drive downloads.
   - **Vanished File Resilience:** If a source file on `~/Desktop` vanishes (`ENOENT`) between directory listing and `getxattr`/`stat`, skip it safely without aborting the run.

3. **Day-by-Day Execution Planner (`createArchivePlan`):**
   - Filter out `skipped-today` files (`fileDate >= today` when `keepToday == true`).
   - Group eligible files by `fileDate` (`YYYY-MM-DD`) in chronological order (`DayPlan[]`).
   - Each day with `<= batchSize` (default `50`) files forms a single batch; only sub-batch within a day when that day exceeds `batchSize`.
   - Create `<destRoot>/<dateFormat>` once per day (`FileManager.default.createDirectory(at:withIntermediateDirectories: true)`).

4. **Concurrency-Safe Deduplication, Symlink Safety & Atomic Native Copy:**
   - Maintain a run-scoped `reservedDestPaths: Set<String>` normalized with `.decomposedStringWithCanonicalMapping.lowercased()` (matching APFS case- and NFD-insensitive semantics) so concurrent tasks (`maxConcurrency = 4`) can never pick the same `(n)` destination slot.
   - Use `lstat(2)` (not `stat(2)`) when probing destination candidates so symlinks in `destDir` are never followed or overwritten.
   - **Deduplication & In-Place Metadata Sync:**
     - If `candidate` exists as a regular file (`S_ISREG`) with identical byte size (`st_size`) and identical `CryptoKit.SHA256` digest:
       - If in `archive` mode (`syncMetadata == true`) and the existing destination file is missing `expectedXattr` or has a mismatched creation timestamp (`abs(srcBirthtime - dstBirthtime) > 1.0s`), sync xattrs and timestamps in place on the existing inode (`copyfile(srcPath, candidatePath, nil, copyfile_flags_t(COPYFILE_METADATA))`) and re-verify before returning `alreadyPresent: true`.
     - If contents differ, advance to `<base> (1)<ext>`, `<base> (2)<ext>`, etc.
   - **Two-Step Atomic Copy + Verification (`archiveSingleFile`):**
     1. Stage copy to a temporary dot-file in `destDir` (`.screenshot-archiver-<uuid>-<filename>`) using `copyfile(srcPath, tmpDestPath, nil, copyfile_flags_t(COPYFILE_ALL | COPYFILE_CLONE))` (preserving data, all extended attributes, ACLs, modification time, and APFS creation time).
     2. Verify on `tmpDestPath` (after optional `beforeVerify` test hook):
        - `lstat` confirms regular file and byte size matches source.
        - `CryptoKit.SHA256` streaming digest matches source.
        - `getxattr` confirms `expectedXattr` (`kMDItemIsScreenCapture` or `kMDItemIsScreenRecording`) is present.
        - Creation timestamp (`st_birthtimespec`) matches within 1 second.
     3. Atomically rename `tmpDestPath` → `finalDestPath` (`rename(2)`).
     4. Only after verification succeeds, remove `sourcePath` (`unlink(2)`) when `deleteSource == true`. If any check fails, remove `tmpDestPath`/`finalDestPath`, release the reserved slot, and keep `sourcePath` untouched.

5. **Audit Trail (`archive.log` + `audit.jsonl`), 50 MB Rotation & Notifications:**
   - Flush each completed day-batch immediately to `archive.log` (human-readable) and `audit.jsonl` (structured JSONL), plus a final `run` summary record.
   - Auto-rotate (`archive.log.1`..`.3` and `audit.jsonl.1`..`.3`) when file size `>= 50 MB` (`50 * 1024 * 1024` bytes), keeping up to 3 rotated files.
   - Reconstruct interrupted runs (or runs that hit a fatal error after completing earlier batches) from their flushed `batch` records in `readAuditHistory`.
   - Trigger a macOS notification (`UNUserNotificationCenter` in app mode, or `osascript` `on run argv` fallback in CLI mode) when `errorCount > 0` or a fatal error occurs.

---

## 3. Target Repository Layout

```text
screenshot-archiver-app/
├── Package.swift                        # Swift 6 package (macOS 14+, zero external dependencies)
├── Sources/
│   ├── ScreenshotArchiverCore/          # Pure, testable core engine library
│   │   ├── Models.swift                 # Config, CandidateFile, DayPlan, ArchivePlan, SummaryResource, AuditRecords
│   │   ├── FilenameParser.swift         # Screenshot/Recording regexes, Buddhist year normalization, dateFormat
│   │   ├── DarwinFileOps.swift          # Native getxattr/setxattr, copyfile(COPYFILE_ALL|COPYFILE_CLONE), lstat/stat, streaming SHA-256
│   │   ├── ScreenCapturePrefs.swift     # Reads com.apple.screencapture location & name
│   │   ├── ArchiverEngine.swift         # Discover -> Plan by Day -> Execute with bounded concurrency
│   │   └── AuditLogger.swift            # archive.log + audit.jsonl writer, 50 MB rotation, history reader
│   └── ScreenshotArchiverApp/           # Hybrid macOS Menu Bar App + Headless CLI executable
│       ├── Main.swift                   # Dispatches to CLI runner when CLI args passed, otherwise launches SwiftUI App
│       ├── CLI.swift                    # Headless CLI (scan, archive, dry-run, history, --json, --verbose, etc.)
│       ├── AppState.swift               # @Observable state, Security-Scoped Bookmarks (NSOpenPanel), daily 03:15 AM scheduler
│       ├── MenuBarView.swift            # MenuBarExtra dropdown: status, last run summary, "Scan", "Archive Now", Settings, History
│       ├── SettingsView.swift           # Folder pickers (Source & Dest), dateFormat, screenshotPrefix, schedule time, keepToday toggle
│       ├── HistoryView.swift            # Table/list of recent runs & archived/failed files from audit.jsonl
│       └── Info.plist                   # Bundle metadata (com.matthew.ScreenshotArchiver, LSUIElement=true)
├── Tests/
│   └── ScreenshotArchiverCoreTests/
│       └── ArchiverEngineTests.swift    # Automated test suite covering all 12+ scenarios
├── scripts/
│   └── build_app.sh                     # Builds release binary and packages /Applications/ScreenshotArchiver.app
└── README.md
```

---

## 4. Execution Steps (In Order)

1. **Initialize Swift Package (`Package.swift`, `.gitignore`):**
   - Configure `ScreenshotArchiverCore`, `ScreenshotArchiverApp`, and `ScreenshotArchiverCoreTests` for macOS 14+ (`swift-tools-version: 6.0`).
2. **Implement `ScreenshotArchiverCore`:**
   - Implement `Models.swift`, `FilenameParser.swift`, `DarwinFileOps.swift`, `ScreenCapturePrefs.swift`, `ArchiverEngine.swift`, and `AuditLogger.swift`.
3. **Implement Comprehensive Test Suite (`Tests/ScreenshotArchiverCoreTests/ArchiverEngineTests.swift`):**
   - Port all 12 test suites from `/Users/matthew/Repositories/vipecoding/screenshot-archiver/test/archiver.test.ts` (dateFormat/tilde expansion, filename/Buddhist year/custom prefix parsing, `com.apple.screencapture` plist detection, `xattr` inspection, end-to-end `scan`/`dry-run`/`archive` with `copyfile` + `SHA256` + `xattr` + `birthtime`, deduplication & in-place metadata sync, verification failure rollback, `sourceDir` override, `deleteSource=false`, day-by-day planning & sub-batching, and audit log persistence/interrupted-run recovery/rotation).
   - Run `swift test` and verify 100% pass.
4. **Implement `ScreenshotArchiverApp` (CLI + SwiftUI Menu Bar UI):**
   - Implement `CLI.swift`, `AppState.swift` (with Security-Scoped Bookmarks and daily 03:15 AM timer), `MenuBarView.swift`, `SettingsView.swift`, `HistoryView.swift`, and `Main.swift`.
5. **Build `/Applications/ScreenshotArchiver.app` & Run Adversarial Review:**
   - Create `scripts/build_app.sh` to compile in release mode, assemble `/Applications/ScreenshotArchiver.app` with `Contents/Info.plist` and ad-hoc code signing (`codesign --force --deep --sign - --identifier com.matthew.ScreenshotArchiver`), and verify both `/Applications/ScreenshotArchiver.app/Contents/MacOS/ScreenshotArchiver scan --verbose` and the `.app` bundle.
   - Run an independent adversarial review subagent against the codebase and fix any issues found.
