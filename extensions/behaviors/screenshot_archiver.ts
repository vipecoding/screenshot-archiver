/**
 * Archive macOS Desktop screenshots and screen recordings into configurable
 * date folders in iCloud Drive / Obsidian using a verified two-step rsync
 * (`-aXN` + `--checksum`) workflow before removing source files.
 *
 * @module
 */
import { extname, join, parse } from "node:path";
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  sourceDir: z
    .string()
    .min(1)
    .describe(
      "Source directory containing macOS screenshots and screen recordings (e.g. '/Users/alice/Desktop' or '~/Desktop')",
    ),
  destRoot: z
    .string()
    .min(1)
    .describe(
      "Root destination directory where date subfolders live (e.g. '/Users/alice/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Daily')",
    ),
  dateFormat: z
    .string()
    .default("YYYY/MM/DD")
    .describe(
      "Obsidian-style date folder format using YYYY, YY, MM, DD tokens (e.g. 'YYYY/MM/DD', 'YYYY-MM-DD', 'YYYY/MM/YYYY-MM-DD')",
    ),
  keepToday: z
    .boolean()
    .default(true)
    .describe(
      "Keep files whose filename date is today or later in the source directory",
    ),
});

/** Validated global arguments for the `@matty/screenshot-archiver` behavior. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CandidateFileSchema = z.object({
  filename: z.string(),
  kind: z.enum(["screenshot", "screen-recording"]),
  fileDate: z.string(),
  sizeBytes: z.number(),
  dataless: z.boolean(),
  hasScreenCaptureXattr: z.boolean(),
  status: z.enum([
    "ready-to-archive",
    "skipped-today",
    "would-archive",
    "copied-verified",
    "already-present-verified",
    "archived",
    "archived-deduplicated",
    "error",
  ]),
  sourcePath: z.string(),
  destDir: z.string().nullable(),
  destDirExists: z.boolean().nullable(),
  destPath: z.string().nullable(),
  sourceDeleted: z.boolean(),
  error: z.string().nullable(),
});

/** Per-file scan or archive result record. */
export type CandidateFile = z.infer<typeof CandidateFileSchema>;

const SummaryResourceSchema = z.object({
  mode: z.enum(["scan", "dry-run", "copy-verify", "archive"]),
  deleteSource: z.boolean(),
  timestamp: z.string(),
  today: z.string(),
  sourceDir: z.string(),
  destRoot: z.string(),
  dateFormat: z.string(),
  destRootExists: z.boolean(),
  scannedCount: z.number(),
  matchedCount: z.number(),
  eligibleCount: z.number(),
  copiedVerifiedCount: z.number(),
  deduplicatedCount: z.number(),
  archivedCount: z.number(),
  skippedTodayCount: z.number(),
  skippedUnparseableCount: z.number(),
  skippedMissingXattrCount: z.number(),
  datalessCount: z.number(),
  errorCount: z.number(),
  files: z.array(CandidateFileSchema),
});

/** Summary resource payload produced by `scan` and `archive`. */
export type SummaryResource = z.infer<typeof SummaryResourceSchema>;

const SCREENSHOT_REGEX =
  /^(Screenshot|Screen Recording)\s+(\d{4}-\d{2}-\d{2})\s+at\s+/;

const ALLOWED_SCREENSHOT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".tiff",
  ".tif",
  ".gif",
  ".heic",
]);

const SCREENSHOT_XATTR = "com.apple.metadata:kMDItemIsScreenCapture";
const SCREEN_RECORDING_XATTR = "com.apple.metadata:kMDItemIsScreenRecording";
const XATTR_BATCH_SIZE = 200;

function buildSubprocessPath(): string {
  const homebrewPrefix =
    "/opt/homebrew/opt/rsync/bin:/opt/homebrew/bin:/usr/local/bin";
  let existingPath = "";
  try {
    existingPath = Deno.env.get("PATH") ?? "";
  } catch {
    // Fallback if --allow-env is not granted in restricted test runners
  }
  const suffix = existingPath || "/usr/bin:/bin";
  return `${homebrewPrefix}:${suffix}`;
}

/**
 * Subprocess environment prepending Homebrew `rsync` locations ahead of the
 * active `PATH` so macOS's built-in `openrsync` (2.6.9) is not selected when
 * Homebrew `rsync` (3.x+) is installed.
 */
export const SUBPROCESS_ENV: Record<string, string> = {
  PATH: buildSubprocessPath(),
};

/**
 * Expand a leading `~` or `~/` in a filesystem path using `HOME`.
 */
export function expandHomePath(
  inputPath: string,
  homeOverride?: string,
): string {
  const trimmed = inputPath.trim();
  if (trimmed !== "~" && !trimmed.startsWith("~/")) {
    return trimmed;
  }
  let home = homeOverride ?? "";
  if (!home) {
    try {
      home = Deno.env.get("HOME") ?? "";
    } catch {
      // Ignore if --allow-env is not granted
    }
  }
  if (!home) {
    return trimmed;
  }
  return trimmed === "~" ? home : join(home, trimmed.slice(2));
}

/** Return today's local date formatted as YYYY-MM-DD. */
export function getLocalToday(now: Date = new Date()): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Validate that a YYYY-MM-DD string represents a real calendar date. */
export function isValidDateString(dateStr: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Format a YYYY-MM-DD date string using an Obsidian-style date folder pattern
 * supporting YYYY, YY, MM, and DD tokens.
 */
export function formatDateSubpath(
  fileDate: string,
  dateFormat: string,
): string {
  const trimmed = dateFormat.trim().replace(/^\/+|\/+$/g, "");
  const parts = trimmed.split("/");
  if (
    !trimmed ||
    trimmed.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `Invalid dateFormat '${dateFormat}': must be a relative subfolder pattern without empty or '..' segments`,
    );
  }
  if (!/(YYYY|YY|MM|DD)/.test(trimmed)) {
    throw new Error(
      `Invalid dateFormat '${dateFormat}': must contain at least one date token (YYYY, YY, MM, or DD)`,
    );
  }
  const yyyy = fileDate.slice(0, 4);
  const yy = fileDate.slice(2, 4);
  const mm = fileDate.slice(5, 7);
  const dd = fileDate.slice(8, 10);

  return trimmed.replace(/YYYY|YY|MM|DD/g, (token) => {
    switch (token) {
      case "YYYY":
        return yyyy;
      case "YY":
        return yy;
      case "MM":
        return mm;
      case "DD":
        return dd;
      default:
        return token;
    }
  });
}

/**
 * Normalize a YYYY-MM-DD string from a screenshot filename.
 * When macOS Region is set to Thailand (or Buddhist calendar), `screencapture`
 * formats the year as Buddhist Era (Gregorian + 543, e.g. 2569 for 2026).
 * If the year falls within the realistic Buddhist Era window relative to
 * `referenceYear` (`[referenceYear + 500, referenceYear + 545]`), subtract 543
 * to convert it to the Gregorian year.
 */
export function normalizeScreenshotDate(
  rawDate: string,
  referenceYear: number = new Date().getFullYear(),
): string {
  const match = /^(\d{4})-(\d{2}-\d{2})$/.exec(rawDate);
  if (!match) return rawDate;
  let year = Number(match[1]);
  if (year >= referenceYear + 500 && year <= referenceYear + 545) {
    year -= 543;
  }
  return `${String(year).padStart(4, "0")}-${match[2]}`;
}

/** Parse a macOS screenshot or screen recording filename. */
export function parseScreenshotFilename(
  filename: string,
  referenceYear: number = new Date().getFullYear(),
): {
  matchedPrefix: boolean;
  kind?: "screenshot" | "screen-recording";
  fileDate?: string;
} {
  const isScreenRecordingPrefix = filename.startsWith("Screen Recording ");
  const isScreenshotPrefix = filename.startsWith("Screenshot ");

  if (!isScreenshotPrefix && !isScreenRecordingPrefix) {
    return { matchedPrefix: false };
  }

  const ext = extname(filename).toLowerCase();
  if (isScreenshotPrefix && !ALLOWED_SCREENSHOT_EXTENSIONS.has(ext)) {
    return { matchedPrefix: false };
  }
  if (isScreenRecordingPrefix && ext !== ".mov") {
    return { matchedPrefix: false };
  }

  const match = SCREENSHOT_REGEX.exec(filename);
  if (!match) {
    return { matchedPrefix: true };
  }

  const kind: "screenshot" | "screen-recording" =
    match[1] === "Screen Recording" ? "screen-recording" : "screenshot";

  const normalizedDate = normalizeScreenshotDate(match[2], referenceYear);
  if (!isValidDateString(normalizedDate)) {
    return { matchedPrefix: true };
  }

  return {
    matchedPrefix: true,
    kind,
    fileDate: normalizedDate,
  };
}

/**
 * Inspect extended attributes for a list of file paths in chunked `xattr`
 * calls. Reading xattrs on APFS does not trigger iCloud downloads on dataless files.
 */
export async function getExtendedAttributesMap(
  filePaths: string[],
  batchSize: number = XATTR_BATCH_SIZE,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (filePaths.length === 0) return result;

  for (const filePath of filePaths) {
    if (!result.has(filePath)) {
      result.set(filePath, new Set<string>());
    }
  }

  const effectiveBatchSize = Math.max(1, Math.trunc(batchSize));
  for (let i = 0; i < filePaths.length; i += effectiveBatchSize) {
    const batch = filePaths.slice(i, i + effectiveBatchSize);
    // swamp-quality-ignore deno-command
    const cmd = new Deno.Command("xattr", {
      args: ["--", ...batch],
      env: SUBPROCESS_ENV,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.code !== 0) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      throw new Error(
        `xattr exited with code ${output.code}: ${stderr || "unknown error"}`,
      );
    }

    const stdout = new TextDecoder().decode(output.stdout);
    if (batch.length === 1) {
      const singleSet = result.get(batch[0])!;
      for (const rawLine of stdout.split("\n")) {
        const attrName = rawLine.trim();
        if (attrName) {
          singleSet.add(attrName);
        }
      }
      continue;
    }

    for (const rawLine of stdout.split("\n")) {
      if (!rawLine.trim()) continue;
      let matchedPath: string | null = null;
      let attrName = "";

      for (const candidatePath of batch) {
        const prefix = `${candidatePath}: `;
        if (rawLine.startsWith(prefix)) {
          matchedPath = candidatePath;
          attrName = rawLine.slice(prefix.length).trim();
          break;
        }
      }

      if (!matchedPath) {
        const sepIndex = rawLine.lastIndexOf(": ");
        if (sepIndex !== -1) {
          matchedPath = rawLine.slice(0, sepIndex);
          attrName = rawLine.slice(sepIndex + 2).trim();
        }
      }

      if (matchedPath && attrName) {
        let set = result.get(matchedPath);
        if (!set) {
          set = new Set<string>();
          result.set(matchedPath, set);
        }
        set.add(attrName);
      }
    }
  }

  return result;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const info = await Deno.stat(p);
    return info.isDirectory;
  } catch {
    return false;
  }
}

function birthtimesMatch(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return true;
  return Math.abs(a.getTime() - b.getTime()) <= 1000;
}

async function runRsyncCopy(
  sourcePath: string,
  destPath: string,
  useChecksum = false,
): Promise<{ ok: boolean; stderr: string }> {
  const args = useChecksum
    ? ["-aXN", "--checksum", "--", sourcePath, destPath]
    : ["-aXN", "--", sourcePath, destPath];
  // swamp-quality-ignore deno-command
  const cmd = new Deno.Command("rsync", {
    args,
    env: SUBPROCESS_ENV,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  return { ok: output.code === 0, stderr };
}

async function runRsyncChecksumVerify(
  sourcePath: string,
  destPath: string,
  includeMetadata = false,
): Promise<{ ok: boolean; details: string }> {
  const args = includeMetadata
    ? [
      "--dry-run",
      "-aXN",
      "--checksum",
      "--itemize-changes",
      "--",
      sourcePath,
      destPath,
    ]
    : [
      "--dry-run",
      "--checksum",
      "--itemize-changes",
      "--",
      sourcePath,
      destPath,
    ];
  // swamp-quality-ignore deno-command
  const cmd = new Deno.Command("rsync", {
    args,
    env: SUBPROCESS_ENV,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (output.code !== 0) {
    return {
      ok: false,
      details: stderr || `rsync exited with code ${output.code}`,
    };
  }
  if (stdout.length > 0) {
    return {
      ok: false,
      details: `rsync checksum check reported differences: ${stdout}`,
    };
  }
  return { ok: true, details: "rsync checksum verified" };
}

/**
 * Verify that `rsync` on the given `env` is a modern 3.x+ build supporting
 * `-X` (`xattrs`) and `-N` (`crtimes`), rather than macOS `openrsync`.
 */
export async function checkModernRsync(
  env: Record<string, string> = SUBPROCESS_ENV,
): Promise<{ pass: boolean; errors?: string[] }> {
  let output: Deno.CommandOutput;
  try {
    // swamp-quality-ignore deno-command
    const cmd = new Deno.Command("rsync", {
      args: ["--version"],
      env,
      stdout: "piped",
      stderr: "piped",
    });
    output = await cmd.output();
  } catch (err) {
    return {
      pass: false,
      errors: [
        `Failed to execute rsync (install via 'brew install rsync'): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    };
  }

  const stdout = new TextDecoder().decode(output.stdout);
  const firstLine = stdout.split("\n")[0]?.trim() ?? "";
  const hasXattrs = /\bxattrs\b/.test(stdout);
  const hasCrtimes = /\bcrtimes\b/.test(stdout);

  if (
    output.code !== 0 ||
    firstLine.startsWith("openrsync") ||
    !hasXattrs ||
    !hasCrtimes
  ) {
    return {
      pass: false,
      errors: [
        `Expected modern rsync 3.x+ with xattrs (-X) and crtimes (-N) support (e.g. Homebrew 'brew install rsync'), but got: '${
          firstLine || "none"
        }'`,
      ],
    };
  }
  return { pass: true };
}

/**
 * Check if an existing file in `destDir` (`filename`, `filename (1)`, ...) already
 * matches `sourcePath` by byte size and `rsync --checksum`.
 * If a byte-for-byte match is found and the destination file is missing the
 * expected extended attribute or creation timestamp, syncs metadata in place via
 * `rsync -aXN --checksum` and re-verifies before returning.
 * Otherwise returns `{ alreadyPresent: false, destPath }` pointing to the first
 * unoccupied filename slot.
 */
async function resolveDestinationWithDeduplication(
  sourcePath: string,
  sourceStat: Deno.FileInfo,
  destDir: string,
  filename: string,
  expectedXattr: string,
): Promise<{ alreadyPresent: boolean; destPath: string }> {
  const { name: base, ext } = parse(filename);
  const sourceSizeBytes = sourceStat.size;
  let candidate = join(destDir, filename);
  let n = 1;

  while (await pathExists(candidate)) {
    const destStat = await Deno.stat(candidate);
    if (destStat.isFile && destStat.size === sourceSizeBytes) {
      const rsyncCheck = await runRsyncChecksumVerify(
        sourcePath,
        candidate,
        false,
      );
      if (rsyncCheck.ok) {
        const existingXattrs = await getExtendedAttributesMap([candidate]);
        const hasXattr = Boolean(
          existingXattrs.get(candidate)?.has(expectedXattr),
        );
        const hasMatchingBirthtime = birthtimesMatch(
          sourceStat.birthtime,
          destStat.birthtime,
        );

        if (!hasXattr || !hasMatchingBirthtime) {
          // Use --checksum so rsync sees the file contents already match and updates
          // xattrs (-X) and creation time (-N) in place on the existing inode.
          const syncResult = await runRsyncCopy(sourcePath, candidate, true);
          if (!syncResult.ok) {
            throw new Error(
              `rsync metadata sync failed on existing file: ${syncResult.stderr}`,
            );
          }
          const recheck = await runRsyncChecksumVerify(
            sourcePath,
            candidate,
            true,
          );
          if (!recheck.ok) {
            throw new Error(recheck.details);
          }
          const [reverifiedStat, reverifiedXattrs] = await Promise.all([
            Deno.stat(candidate),
            getExtendedAttributesMap([candidate]),
          ]);
          if (reverifiedStat.size !== sourceSizeBytes) {
            throw new Error(
              `Size mismatch after metadata sync on existing file: ${candidate}`,
            );
          }
          if (!reverifiedXattrs.get(candidate)?.has(expectedXattr)) {
            throw new Error(
              `Destination file is missing expected extended attribute ${expectedXattr} after rsync -aXN: ${candidate}`,
            );
          }
          if (
            !birthtimesMatch(sourceStat.birthtime, reverifiedStat.birthtime)
          ) {
            throw new Error(
              `Destination file creation timestamp mismatch after rsync -aXN: ${candidate}`,
            );
          }
        }

        return {
          alreadyPresent: true,
          destPath: candidate,
        };
      }
    }
    candidate = join(destDir, `${base} (${n})${ext}`);
    n += 1;
  }

  return { alreadyPresent: false, destPath: candidate };
}

/** Scan or archive screenshots according to `mode`. */
export async function inspectAndProcess(
  globalArgs: GlobalArgs,
  mode: "scan" | "dry-run" | "archive",
  todayOverride?: string,
  options?: {
    deleteSource?: boolean;
    sourceDirOverride?: string;
    destRootOverride?: string;
    beforeVerify?: (destPath: string) => Promise<void> | void;
  },
): Promise<SummaryResource> {
  const { dateFormat = "YYYY/MM/DD", keepToday } = globalArgs;
  const sourceDir = expandHomePath(
    options?.sourceDirOverride || globalArgs.sourceDir,
  );
  const destRoot = expandHomePath(
    options?.destRootOverride || globalArgs.destRoot,
  );
  const deleteSource = options?.deleteSource ?? true;

  if (!(await isDirectory(sourceDir))) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }
  const destRootExists = await isDirectory(destRoot);
  if (!destRootExists && mode === "archive") {
    throw new Error(
      `Destination root directory is not available: ${destRoot}. Aborting safely without touching any files.`,
    );
  }

  const today = todayOverride ?? getLocalToday();
  const referenceYear = Number(today.slice(0, 4));
  let scannedCount = 0;
  let matchedCount = 0;
  let eligibleCount = 0;
  let copiedVerifiedCount = 0;
  let deduplicatedCount = 0;
  let archivedCount = 0;
  let skippedTodayCount = 0;
  let skippedUnparseableCount = 0;
  let skippedMissingXattrCount = 0;
  let datalessCount = 0;
  let errorCount = 0;
  const files: CandidateFile[] = [];

  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(sourceDir)) {
    entries.push(entry);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  // First pass: collect parseable candidate filenames and paths so we can query xattr in batches
  const parsedCandidates: Array<{
    filename: string;
    sourcePath: string;
    kind: "screenshot" | "screen-recording";
    fileDate: string;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile) continue;
    scannedCount += 1;
    const filename = entry.name;
    const parsed = parseScreenshotFilename(filename, referenceYear);
    if (!parsed.matchedPrefix) {
      continue;
    }
    if (!parsed.fileDate || !parsed.kind) {
      skippedUnparseableCount += 1;
      continue;
    }
    parsedCandidates.push({
      filename,
      sourcePath: join(sourceDir, filename),
      kind: parsed.kind,
      fileDate: parsed.fileDate,
    });
  }

  const xattrMap = await getExtendedAttributesMap(
    parsedCandidates.map((c) => c.sourcePath),
  );

  for (const { filename, sourcePath, kind, fileDate } of parsedCandidates) {
    const expectedXattr = kind === "screen-recording"
      ? SCREEN_RECORDING_XATTR
      : SCREENSHOT_XATTR;
    const fileXattrs = xattrMap.get(sourcePath);
    const hasScreenCaptureXattr = Boolean(fileXattrs?.has(expectedXattr));

    if (!hasScreenCaptureXattr) {
      skippedMissingXattrCount += 1;
      continue;
    }

    matchedCount += 1;

    const statInfo = await Deno.stat(sourcePath);
    const sizeBytes = statInfo.size;
    // On modern macOS APFS + FileProvider, evicted dataless files report logical size > 0
    // with 0 allocated blocks on disk.
    const dataless = sizeBytes > 0 && statInfo.blocks === 0;
    if (dataless) {
      datalessCount += 1;
    }

    if (keepToday && fileDate >= today) {
      skippedTodayCount += 1;
      files.push({
        filename,
        kind,
        fileDate,
        sizeBytes,
        dataless,
        hasScreenCaptureXattr,
        status: "skipped-today",
        sourcePath,
        destDir: null,
        destDirExists: null,
        destPath: null,
        sourceDeleted: false,
        error: null,
      });
      continue;
    }

    eligibleCount += 1;
    const dateSubpath = formatDateSubpath(fileDate, dateFormat);
    const destDir = join(destRoot, dateSubpath);
    const destDirExistsBefore = await isDirectory(destDir);

    if (mode === "scan" || mode === "dry-run") {
      const previewDestPath = join(destDir, filename);
      files.push({
        filename,
        kind,
        fileDate,
        sizeBytes,
        dataless,
        hasScreenCaptureXattr,
        status: mode === "scan" ? "ready-to-archive" : "would-archive",
        sourcePath,
        destDir,
        destDirExists: destDirExistsBefore,
        destPath: previewDestPath,
        sourceDeleted: false,
        error: null,
      });
      continue;
    }

    // Mode === "archive":
    let attemptedDestPath: string | null = null;
    let createdNewDestFile = false;
    try {
      // 1. Ensure date subfolder exists
      await Deno.mkdir(destDir, { recursive: true });

      // 2. Check if an identical file (by byte size and rsync --checksum) already exists in destDir
      const resolved = await resolveDestinationWithDeduplication(
        sourcePath,
        statInfo,
        destDir,
        filename,
        expectedXattr,
      );
      attemptedDestPath = resolved.destPath;

      if (resolved.alreadyPresent) {
        deduplicatedCount += 1;
        if (deleteSource) {
          await Deno.remove(sourcePath);
          archivedCount += 1;
        }
        files.push({
          filename,
          kind,
          fileDate,
          sizeBytes,
          dataless,
          hasScreenCaptureXattr,
          status: deleteSource
            ? "archived-deduplicated"
            : "already-present-verified",
          sourcePath,
          destDir,
          destDirExists: true,
          destPath: resolved.destPath,
          sourceDeleted: deleteSource,
          error: null,
        });
        continue;
      }

      const finalDestPath = resolved.destPath;
      createdNewDestFile = true;

      // 3. Step 1 of rsync: copy file to destination with -aXN (archive + xattrs + crtimes) without removing source
      const copyResult = await runRsyncCopy(sourcePath, finalDestPath);
      if (!copyResult.ok) {
        throw new Error(`rsync copy failed: ${copyResult.stderr}`);
      }

      if (options?.beforeVerify) {
        await options.beforeVerify(finalDestPath);
      }

      // 4. Step 2 of rsync: verify with -aXN --checksum --itemize-changes + stat + xattr presence
      const verifyResult = await runRsyncChecksumVerify(
        sourcePath,
        finalDestPath,
        true,
      );
      if (!verifyResult.ok) {
        throw new Error(verifyResult.details);
      }

      const [destStat, destXattrs] = await Promise.all([
        Deno.stat(finalDestPath),
        getExtendedAttributesMap([finalDestPath]),
      ]);

      if (destStat.size !== sizeBytes) {
        throw new Error(
          `Size mismatch (src=${sizeBytes}, dst=${destStat.size})`,
        );
      }
      if (!destXattrs.get(finalDestPath)?.has(expectedXattr)) {
        throw new Error(
          `Destination file is missing expected extended attribute ${expectedXattr}: ${finalDestPath}`,
        );
      }
      if (!birthtimesMatch(statInfo.birthtime, destStat.birthtime)) {
        throw new Error(
          `Destination file creation timestamp mismatch: ${finalDestPath}`,
        );
      }

      createdNewDestFile = false;
      copiedVerifiedCount += 1;

      // 5. Delete from sourceDir ONLY when deleteSource is true and verification succeeded
      if (deleteSource) {
        await Deno.remove(sourcePath);
        archivedCount += 1;
      }

      files.push({
        filename,
        kind,
        fileDate,
        sizeBytes,
        dataless,
        hasScreenCaptureXattr,
        status: deleteSource ? "archived" : "copied-verified",
        sourcePath,
        destDir,
        destDirExists: true,
        destPath: finalDestPath,
        sourceDeleted: deleteSource,
        error: null,
      });
    } catch (err) {
      if (createdNewDestFile && attemptedDestPath) {
        try {
          await Deno.remove(attemptedDestPath);
        } catch {
          // Ignore if destination file was never created before failure
        }
      }
      errorCount += 1;
      files.push({
        filename,
        kind,
        fileDate,
        sizeBytes,
        dataless,
        hasScreenCaptureXattr,
        status: "error",
        sourcePath,
        destDir,
        destDirExists: destDirExistsBefore,
        destPath: attemptedDestPath ?? join(destDir, filename),
        sourceDeleted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const effectiveMode: "scan" | "dry-run" | "copy-verify" | "archive" =
    mode === "archive" && !deleteSource ? "copy-verify" : mode;

  return {
    mode: effectiveMode,
    deleteSource: mode === "archive" ? deleteSource : false,
    timestamp: new Date().toISOString(),
    today,
    sourceDir,
    destRoot,
    dateFormat,
    destRootExists,
    scannedCount,
    matchedCount,
    eligibleCount,
    copiedVerifiedCount,
    deduplicatedCount,
    archivedCount,
    skippedTodayCount,
    skippedUnparseableCount,
    skippedMissingXattrCount,
    datalessCount,
    errorCount,
    files,
  };
}

/** Behavior definition for archiving macOS screenshots and screen recordings. */
export const behavior = {
  type: "@matty/screenshot-archiver",
  version: "2026.11.05.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description:
        "Scan or archive summary including per-file status, destination paths, dataless detection, xattr verification, deduplication, and rsync checksum verification",
      schema: SummaryResourceSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  checks: {
    "valid-date-format": {
      description:
        "Verify dateFormat is a valid relative subfolder pattern containing date tokens",
      labels: ["policy"],
      execute: (context: { globalArgs: GlobalArgs }) => {
        try {
          formatDateSubpath("2026-11-05", context.globalArgs.dateFormat);
          return Promise.resolve({ pass: true });
        } catch (err) {
          return Promise.resolve({
            pass: false,
            errors: [err instanceof Error ? err.message : String(err)],
          });
        }
      },
    },
    "directories-exist": {
      description:
        "Verify configured sourceDir and destRoot directories exist on disk before archiving",
      labels: ["live"],
      appliesTo: ["archive"],
      execute: async (context: {
        globalArgs: GlobalArgs;
        methodArgs?: { sourceDir?: string; destRoot?: string };
      }) => {
        const errors: string[] = [];
        const sourceDir = expandHomePath(
          context.methodArgs?.sourceDir || context.globalArgs.sourceDir,
        );
        const destRoot = expandHomePath(
          context.methodArgs?.destRoot || context.globalArgs.destRoot,
        );
        if (!(await isDirectory(sourceDir))) {
          errors.push(`Source directory does not exist: ${sourceDir}`);
        }
        if (!(await isDirectory(destRoot))) {
          errors.push(`Destination root directory does not exist: ${destRoot}`);
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
    "modern-rsync": {
      description:
        "Verify Homebrew/GNU rsync 3.x+ (with -X extended attribute and -N creation timestamp support) is used rather than macOS openrsync",
      labels: ["live"],
      appliesTo: ["archive"],
      execute: () => checkModernRsync(),
    },
  },
  methods: {
    scan: {
      kind: "read",
      description:
        "Read-only scan of screenshots and screen recordings, showing target date folders without modifying any files",
      arguments: z.object({
        sourceDir: z
          .string()
          .optional()
          .describe(
            "Optional source directory override (e.g. '/Users/alice/Desktop/Screenshots')",
          ),
        destRoot: z
          .string()
          .optional()
          .describe("Optional destination root directory override"),
      }),
      execute: async (
        args: { sourceDir?: string; destRoot?: string },
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const effectiveSourceDir = expandHomePath(
          args.sourceDir || context.globalArgs.sourceDir,
        );
        context.logger?.info("Scanning screenshots in {sourceDir}", {
          sourceDir: effectiveSourceDir,
        });
        const result = await inspectAndProcess(
          context.globalArgs,
          "scan",
          undefined,
          {
            sourceDirOverride: args.sourceDir,
            destRootOverride: args.destRoot,
          },
        );
        const handle = await context.writeResource("summary", "main", result);
        context.logger?.info(
          "Scan completed: {eligibleCount} eligible of {scannedCount} scanned",
          {
            scannedCount: result.scannedCount,
            matchedCount: result.matchedCount,
            eligibleCount: result.eligibleCount,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    archive: {
      description:
        "Copy eligible screenshots (< today) into configured date folders via rsync -aXN, verify with rsync --checksum (deduplicating identical existing files), then optionally remove from sourceDir",
      arguments: z.object({
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            "When true, preview archive actions without creating folders or moving files",
          ),
        deleteSource: z
          .boolean()
          .default(true)
          .describe(
            "When true (default), remove each source file from sourceDir after checksum verification succeeds; set to false to copy and verify without deleting",
          ),
        sourceDir: z
          .string()
          .optional()
          .describe(
            "Optional source directory override (e.g. '/Users/alice/Desktop/Screenshots'); files are scanned and removed from this directory",
          ),
        destRoot: z
          .string()
          .optional()
          .describe(
            "Optional destination root directory override (useful for testing to a temporary folder)",
          ),
      }),
      execute: async (
        args: {
          dryRun: boolean;
          deleteSource: boolean;
          sourceDir?: string;
          destRoot?: string;
        },
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            error: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const mode = args.dryRun ? "dry-run" : "archive";
        const effectiveSourceDir = expandHomePath(
          args.sourceDir || context.globalArgs.sourceDir,
        );
        context.logger?.info("Running screenshot {mode} on {sourceDir}", {
          mode,
          sourceDir: effectiveSourceDir,
          deleteSource: args.deleteSource ?? true,
        });
        const result = await inspectAndProcess(
          context.globalArgs,
          mode,
          undefined,
          {
            deleteSource: args.deleteSource ?? true,
            sourceDirOverride: args.sourceDir,
            destRootOverride: args.destRoot,
          },
        );
        const handle = await context.writeResource("summary", "main", result);
        if (result.errorCount > 0) {
          const failedFiles = result.files
            .filter((f) => f.status === "error" || f.error !== null)
            .map((f) => `${f.filename}: ${f.error ?? "unknown error"}`);
          const errorDetails = failedFiles.join("; ");
          context.logger?.error(
            "Archive encountered {errorCount} verification or copy error(s) in {sourceDir}: {errorDetails}",
            {
              errorCount: result.errorCount,
              sourceDir: result.sourceDir,
              errors: failedFiles,
              errorDetails,
            },
          );
          throw new Error(
            `Archive completed with ${result.errorCount} verification or copy error(s); unverified source files were kept in ${result.sourceDir}: ${errorDetails}`,
          );
        }
        context.logger?.info(
          "Archive completed: {archivedCount} archived ({copiedVerifiedCount} copied, {deduplicatedCount} deduplicated)",
          {
            archivedCount: result.archivedCount,
            copiedVerifiedCount: result.copiedVerifiedCount,
            deduplicatedCount: result.deduplicatedCount,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
