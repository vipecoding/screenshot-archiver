# Plan 2: Native Swift macOS Menu Bar App (`vipecoding/screenshot-archiver-app`)

## 1. Goal & Why Native Swift

After merging the standalone TypeScript CLI in `vipecoding/screenshot-archiver`, we will build a **native Swift 6 macOS Menu Bar application** in a new repository:
- **Local path:** `/Users/matthew/Repositories/vipecoding/screenshot-archiver-app`
- **GitHub repo:** `vipecoding/screenshot-archiver-app`

### Why This Replaces Every Moving Part
| Concern | TypeScript CLI + `launchd` | Native Swift `ScreenshotArchiver.app` |
| :--- | :--- | :--- |
| **Artifacts** | TS source + 89 MB Bun binary + AppleScript `.app` + shell scripts + LaunchAgent plist | **Single ~500 KB `.app` bundle** (`/Applications/ScreenshotArchiver.app`) |
| **External Dependencies** | Requires Homebrew `rsync` 3.x+ (`brew install rsync`) and Bun | **Zero external dependencies** (100% macOS Darwin + Apple frameworks) |
| **Permissions (TCC)** | Requires Full Disk Access on `ScreenshotArchiverRunner.app` | **No Full Disk Access required**—uses macOS **Security-Scoped Bookmarks** granted when picking Source & Destination folders in `NSOpenPanel` |
| **File Copy & Verification** | Spawns `rsync` and `xattr` subprocesses | **In-process native Darwin `copyfile(3)` (`COPYFILE_ALL \| COPYFILE_CLONE`) + `getxattr(2)` + `CryptoKit` SHA-256** |
| **macOS Screenshot Config** | Spawns `/usr/bin/defaults read com.apple.screencapture` | Native `UserDefaults(suiteName: "com.apple.screencapture")` |
| **Configuration & Control** | CLI flags only | Native **SwiftUI Menu Bar utility (`MenuBarExtra`)** + Settings window + "Archive Now" + History viewer + headless `--archive` CLI mode |

---

## 2. Core Domain Rules to Preserve (Proven in `vipecoding/screenshot-archiver`)

The Swift app must preserve 100% of the safety guarantees and edge-case handling proven in the TypeScript implementation:

1. **Auto-Detection of macOS Screenshot Preferences (`com.apple.screencapture`):**
   - Read `UserDefaults(suiteName: "com.apple.screencapture")`:
     - `location` (default `~/Desktop` if unset).
     - `name` (default `"Screenshot"` if unset).
   - Allow user override in the app's Settings UI via a native folder picker (`NSOpenPanel`).

2. **Strict Filename + Extension + Extended Attribute Matching:**
   - **Screenshots:** `^<prefix>\s+(\d{4}-\d{2}-\d{2})\s+at\s+.+\.(png|jpe?g|pdf|tiff?|gif|heic)$` (case-insensitive extension) AND must have extended attribute `com.apple.metadata:kMDItemIsScreenCapture`.
   - **Screen Recordings:** `^Screen Recording\s+(\d{4}-\d{2}-\d{2})\s+at\s+.+\.mov$` (case-insensitive extension) AND must have extended attribute `com.apple.metadata:kMDItemIsScreenRecording`.
   - **Buddhist Era Calendar Normalization:** If the parsed 4-digit year falls in `[referenceYear + 500, referenceYear + 545]` (e.g., `2569` in `2026` when macOS Region uses the Buddhist calendar), subtract `543` to normalize to the Gregorian year (`2026`).
   - **Dataless File Detection (APFS + iCloud FileProvider):** Inspect `stat.st_size > 0 && stat.st_blocks == 0` via Darwin `stat(2)` without reading file contents during scan, so evicted iCloud files are not downloaded during attribute inspection.

3. **Day-by-Day Planning (`ArchivePlan`):**
   - Group eligible files (`fileDate < today` when `keepToday == true`) by `fileDate` (`YYYY-MM-DD`) in chronological order.
   - Process day by day; only split a single day into sub-batches (`batchSize = 50`) when that day has more than 50 files.

4. **Two-Step Verified Native Copy & Content-Checksum Deduplication (No `rsync`):**
   - **Deduplication & Collision Resolution:**
     - If `<destDir>/<filename>` already exists, compare byte size (`st_size`) and `CryptoKit.SHA256` digest of source and destination.
     - If byte size and SHA-256 match: deduplicate in place! If the existing destination file is missing `expectedXattr` or has a mismatched creation timestamp (`birthtime`), copy xattrs (`fcopyfile(srcFd, dstFd, nil, COPYFILE_XATTR | COPYFILE_STAT)`) in place on the existing inode without creating a ` (1)` duplicate.
     - If contents differ: try `<base> (1)<ext>`, `<base> (2)<ext>`, etc.
   - **Atomic Copy + Verification:**
     - Stage copy to a temporary dot-file in `destDir` (`.screenshot-archiver-<uuid>-<filename>`) using Darwin `copyfile(src, tmpDst, nil, COPYFILE_ALL | COPYFILE_CLONE)` so data, all extended attributes (`kMDItemIsScreenCapture`, `kMDItemScreenCaptureGlobalRect`, `FinderInfo`, etc.), permissions, modification time, and APFS creation time (`crtime`) are preserved.
     - Verify on `tmpDst`:
       1. Byte size matches source.
       2. `CryptoKit.SHA256` digest matches source.
       3. `getxattr(tmpDst, expectedXattr, ...)` confirms the screen-capture extended attribute is present.
       4. Creation timestamp (`birthtime`) matches within 1 second.
     - Atomically rename `tmpDst` → `finalDestPath` (`rename(2)`).
     - Only after all checks succeed, delete `sourcePath` (`unlink(2)`). If any check fails, remove `tmpDst` and keep `sourcePath` untouched.

5. **Audit Trail (`archive.log` + `audit.jsonl`) & Error Notifications:**
   - Flush each completed day-batch to `archive.log` (human-readable) and `audit.jsonl` (structured JSONL), auto-rotating at **50 MB** (keeping 3 rotated files: `.1`, `.2`, `.3`).
   - Post a native macOS notification via `UNUserNotificationCenter` if any archive error occurs.

---

## 3. Target Repository Layout (`vipecoding/screenshot-archiver-app`)

```text
screenshot-archiver-app/
├── Package.swift                        # Swift 6 Package (macOS 14+ target, zero external deps)
├── Sources/
│   ├── ScreenshotArchiverCore/          # Pure testable engine library
│   │   ├── Models.swift                 # Config, CandidateFile, DayPlan, ArchivePlan, SummaryResource
│   │   ├── FilenameParser.swift         # Screenshot/Recording regexes, Buddhist year normalization, dateFormat
│   │   ├── DarwinFileOps.swift          # Native getxattr/setxattr, copyfile(COPYFILE_ALL), stat dataless check, SHA-256
│   │   ├── ScreenCapturePrefs.swift     # Reads com.apple.screencapture location & name
│   │   ├── ArchiverEngine.swift         # Discover -> Plan by Day -> Execute with bounded concurrency (TaskGroup)
│   │   └── AuditLogger.swift            # archive.log + audit.jsonl writer, 50 MB rotation, history reader
│   └── ScreenshotArchiverApp/           # macOS Menu Bar App + CLI entrypoint
│       ├── ScreenshotArchiverApp.swift  # @main: runs headless CLI if args passed, otherwise launches MenuBarExtra UI
│       ├── AppState.swift               # Observable state, Security-Scoped Bookmarks, daily scheduler (03:15 AM)
│       ├── MenuBarView.swift            # Menu bar dropdown: status, last run summary, "Scan", "Archive Now", Settings
│       ├── SettingsView.swift           # Source/Dest folder pickers, dateFormat, schedule time, keepToday toggle
│       ├── HistoryView.swift            # Searchable/filterable table of recent runs & archived files from audit.jsonl
│       └── Resources/
│           └── Info.plist               # LSUIElement=true (Menu Bar agent, no Dock icon clutter)
├── Tests/
│   └── ScreenshotArchiverCoreTests/
│       └── ArchiverEngineTests.swift    # Comprehensive XCTest / Swift Testing suite covering all edge cases
├── scripts/
│   └── build_app.sh                     # Builds release binary and bundles /Applications/ScreenshotArchiver.app
└── README.md
```

---

## 4. Handover Prompt for Session 3 (Build the Native Swift macOS App)

Copy and paste the prompt below into a new session once PR #2 in `vipecoding/screenshot-archiver` is merged:

```markdown
Read `/Users/matthew/Repositories/vipecoding/screenshot-archiver/plans/02-swift-macos-app-plan.md` and `/Users/matthew/Repositories/vipecoding/screenshot-archiver/src/archiver.ts`.

We are creating the native Swift 6 macOS Menu Bar application in a new repository at `/Users/matthew/Repositories/vipecoding/screenshot-archiver-app` (and GitHub repo `vipecoding/screenshot-archiver-app`).

Execute the plan in `02-swift-macos-app-plan.md`:
1. Create `/Users/matthew/Repositories/vipecoding/screenshot-archiver-app`, initialize git, and set up `Package.swift` with `ScreenshotArchiverCore` (library), `ScreenshotArchiverApp` (executable supporting both the SwiftUI `MenuBarExtra` UI and headless `--scan` / `--archive` / `--history` CLI flags), and `ScreenshotArchiverCoreTests`.
2. Implement `ScreenshotArchiverCore` using 100% native macOS APIs (`copyfile(3)` with `COPYFILE_ALL | COPYFILE_CLONE`, `getxattr(2)`/`listxattr(2)`, `stat(2)` for dataless detection, `CryptoKit.SHA256` for checksum verification, and `UserDefaults(suiteName: "com.apple.screencapture")` for auto-detecting `location` and custom `name` prefix), including the day-by-day `ArchivePlan` and 50 MB auto-rotating `archive.log` + `audit.jsonl` audit trail.
3. Implement `ScreenshotArchiverApp` with Security-Scoped Bookmarks (`NSOpenPanel`) for the Source and Destination directories (so Full Disk Access is not required), configurable daily schedule (defaulting to 03:15 AM), Menu Bar dropdown (`MenuBarExtra`), Settings window, and History viewer window.
4. Port and expand the full automated test suite in `Tests/ScreenshotArchiverCoreTests/ArchiverEngineTests.swift` and verify all tests pass via `swift test`.
5. Build `/Applications/ScreenshotArchiver.app` via `scripts/build_app.sh` and verify both CLI mode and Menu Bar app mode.
```
