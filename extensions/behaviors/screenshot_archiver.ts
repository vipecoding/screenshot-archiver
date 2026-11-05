/**
 * Archive macOS Desktop screenshots and screen recordings into configurable
 * date folders in iCloud Drive / Obsidian using a verified two-step rsync +
 * checksum workflow before removing source files.
 *
 * @module
 */
import { extname, parse } from "node:path";
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  sourceDir: z
    .string()
    .default("/Users/matthew/Desktop")
    .describe("Source directory containing macOS screenshots and screen recordings"),
  destRoot: z
    .string()
    .default(
      "/Users/matthew/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal/Daily",
    )
    .describe("Root destination directory where date subfolders live"),
  dateFormat: z
    .string()
    .default("YYYY/MM/DD")
    .describe(
      "Obsidian-style date folder format using YYYY, YY, MM, DD tokens (e.g. 'YYYY/MM/DD', 'YYYY-MM-DD', 'YYYY/MM/YYYY-MM-DD')",
    ),
  keepToday: z
    .boolean()
    .default(true)
    .describe("Keep files whose filename date is today or later on the Desktop"),
});

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
  sha256: z.string().nullable(),
  sourceDeleted: z.boolean(),
  error: z.string().nullable(),
});

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

const SCREENSHOT_REGEX =
  /^(Screenshot|Screen Recording)\s+(\d{4}-\d{2}-\d{2})\s+at\s+/;

const ALLOWED_SCREENSHOT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".pdf",
  ".tiff",
  ".gif",
  ".heic",
]);

const SCREENSHOT_XATTR = "com.apple.metadata:kMDItemIsScreenCapture";
const SCREEN_RECORDING_XATTR = "com.apple.metadata:kMDItemIsScreenRecording";

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
export function formatDateSubpath(fileDate: string, dateFormat: string): string {
  const trimmed = dateFormat.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid dateFormat '${dateFormat}': must be a relative subfolder pattern`);
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
 * If the year is more than 500 years in the future relative to `referenceYear`
 * (giving a 43-year buffer for historical Buddhist-calendar screenshots),
 * subtract 543 to convert it to the Gregorian year.
 */
export function normalizeScreenshotDate(
  rawDate: string,
  referenceYear: number = new Date().getFullYear(),
): string {
  const match = /^(\d{4})-(\d{2}-\d{2})$/.exec(rawDate);
  if (!match) return rawDate;
  let year = Number(match[1]);
  if (year > referenceYear + 500) {
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
  const startsLikeCandidate =
    filename.startsWith("Screenshot ") ||
    filename.startsWith("Screen Recording ");

  if (!startsLikeCandidate) {
    return { matchedPrefix: false };
  }

  const match = SCREENSHOT_REGEX.exec(filename);
  if (!match) {
    return { matchedPrefix: true };
  }

  const kind: "screenshot" | "screen-recording" =
    match[1] === "Screen Recording" ? "screen-recording" : "screenshot";
  const ext = extname(filename).toLowerCase();
  if (kind === "screenshot" && !ALLOWED_SCREENSHOT_EXTENSIONS.has(ext)) {
    return { matchedPrefix: false };
  }
  if (kind === "screen-recording" && ext !== ".mov") {
    return { matchedPrefix: false };
  }

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
 * Inspect extended attributes for a list of file paths in a single `xattr`
 * call. Reading xattrs on APFS does not trigger iCloud downloads on dataless files.
 */
export async function getExtendedAttributesMap(
  filePaths: string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (filePaths.length === 0) return result;

  const cmd = new Deno.Command("xattr", {
    args: filePaths,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);

  for (const line of stdout.split("\n")) {
    const sepIndex = line.lastIndexOf(": ");
    if (sepIndex === -1) {
      const attrOnly = line.trim();
      if (attrOnly && filePaths.length === 1) {
        const singlePath = filePaths[0];
        let set = result.get(singlePath);
        if (!set) {
          set = new Set<string>();
          result.set(singlePath, set);
        }
        set.add(attrOnly);
      }
      continue;
    }
    const filePath = line.slice(0, sepIndex);
    const attrName = line.slice(sepIndex + 2).trim();
    let set = result.get(filePath);
    if (!set) {
      set = new Set<string>();
      result.set(filePath, set);
    }
    set.add(attrName);
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

/** Find a non-colliding file path in `dir` by appending ` (1)`, ` (2)`, etc. */
export async function nextAvailableDestination(
  dir: string,
  filename: string,
): Promise<string> {
  let candidate = `${dir}/${filename}`;
  const { name: base, ext } = parse(filename);

  let n = 1;
  while (await pathExists(candidate)) {
    candidate = `${dir}/${base} (${n})${ext}`;
    n += 1;
  }
  return candidate;
}

/** Compute the lowercase hex SHA-256 digest of a file on disk. */
export async function computeSha256(filePath: string): Promise<string> {
  const bytes = await Deno.readFile(filePath);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function runRsyncCopy(
  sourcePath: string,
  destPath: string,
): Promise<{ ok: boolean; stderr: string }> {
  const cmd = new Deno.Command("rsync", {
    args: ["-a", "--", sourcePath, destPath],
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
): Promise<{ ok: boolean; details: string }> {
  const cmd = new Deno.Command("rsync", {
    args: ["--dry-run", "--checksum", "--itemize-changes", "--", sourcePath, destPath],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (output.code !== 0) {
    return { ok: false, details: stderr || `rsync exited with code ${output.code}` };
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
 * Check if an existing file in `destDir` (`filename`, `filename (1)`, ...) already
 * matches `sourcePath` by size, `rsync --checksum`, and SHA-256 hash.
 * If a byte-for-byte match is found, returns `{ alreadyPresent: true, destPath, sha256 }`.
 * Otherwise returns `{ alreadyPresent: false, destPath }` pointing to the first
 * unoccupied filename slot.
 */
async function resolveDestinationWithDeduplication(
  sourcePath: string,
  sourceSizeBytes: number,
  destDir: string,
  filename: string,
): Promise<
  | { alreadyPresent: true; destPath: string; sha256: string }
  | { alreadyPresent: false; destPath: string }
> {
  const { name: base, ext } = parse(filename);
  let candidate = `${destDir}/${filename}`;
  let n = 1;
  let cachedSourceSha256: string | null = null;

  while (await pathExists(candidate)) {
    const destStat = await Deno.stat(candidate);
    if (destStat.isFile && destStat.size === sourceSizeBytes) {
      const rsyncCheck = await runRsyncChecksumVerify(sourcePath, candidate);
      if (rsyncCheck.ok) {
        if (!cachedSourceSha256) {
          cachedSourceSha256 = await computeSha256(sourcePath);
        }
        const destSha256 = await computeSha256(candidate);
        if (cachedSourceSha256 === destSha256) {
          return {
            alreadyPresent: true,
            destPath: candidate,
            sha256: destSha256,
          };
        }
      }
    }
    candidate = `${destDir}/${base} (${n})${ext}`;
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
  },
) {
  const { dateFormat = "YYYY/MM/DD", keepToday } = globalArgs;
  const sourceDir = options?.sourceDirOverride || globalArgs.sourceDir;
  const destRoot = options?.destRootOverride || globalArgs.destRoot;
  const deleteSource = options?.deleteSource ?? true;

  if (!(await isDirectory(sourceDir))) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }
  const destRootExists = await isDirectory(destRoot);
  if (!destRootExists) {
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

  // First pass: collect candidate filenames and paths so we can query xattr in one batch
  const parsedCandidates: Array<{
    filename: string;
    sourcePath: string;
    parsed: ReturnType<typeof parseScreenshotFilename>;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile) continue;
    scannedCount += 1;
    const filename = entry.name;
    const parsed = parseScreenshotFilename(filename, referenceYear);
    if (!parsed.matchedPrefix) {
      continue;
    }
    parsedCandidates.push({
      filename,
      sourcePath: `${sourceDir}/${filename}`,
      parsed,
    });
  }

  const xattrMap = await getExtendedAttributesMap(
    parsedCandidates.map((c) => c.sourcePath),
  );

  for (const { filename, sourcePath, parsed } of parsedCandidates) {
    if (!parsed.fileDate || !parsed.kind) {
      matchedCount += 1;
      skippedUnparseableCount += 1;
      continue;
    }

    const { kind, fileDate } = parsed;
    const expectedXattr =
      kind === "screen-recording" ? SCREEN_RECORDING_XATTR : SCREENSHOT_XATTR;
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
        sha256: null,
        sourceDeleted: false,
        error: null,
      });
      continue;
    }

    eligibleCount += 1;
    const dateSubpath = formatDateSubpath(fileDate, dateFormat);
    const destDir = `${destRoot}/${dateSubpath}`;
    const destDirExistsBefore = await isDirectory(destDir);

    if (mode === "scan" || mode === "dry-run") {
      const previewDestPath = `${destDir}/${filename}`;
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
        sha256: null,
        sourceDeleted: false,
        error: null,
      });
      continue;
    }

    // Mode === "archive":
    // 1. Ensure date subfolder exists
    try {
      await Deno.mkdir(destDir, { recursive: true });

      // 2. Check if an identical file (by size, rsync --checksum, and SHA-256) already exists in destDir
      const resolved = await resolveDestinationWithDeduplication(
        sourcePath,
        sizeBytes,
        destDir,
        filename,
      );

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
          status: deleteSource ? "archived-deduplicated" : "already-present-verified",
          sourcePath,
          destDir,
          destDirExists: true,
          destPath: resolved.destPath,
          sha256: resolved.sha256,
          sourceDeleted: deleteSource,
          error: null,
        });
        continue;
      }

      const finalDestPath = resolved.destPath;

      // 3. Step 1 of rsync: copy file to destination without removing source
      const copyResult = await runRsyncCopy(sourcePath, finalDestPath);
      if (!copyResult.ok) {
        throw new Error(`rsync copy failed: ${copyResult.stderr}`);
      }

      // 4. Step 2 of rsync: verify with --checksum + SHA-256 byte-for-byte comparison
      const verifyResult = await runRsyncChecksumVerify(sourcePath, finalDestPath);
      if (!verifyResult.ok) {
        throw new Error(verifyResult.details);
      }

      const [sourceSha256, destSha256, destStat] = await Promise.all([
        computeSha256(sourcePath),
        computeSha256(finalDestPath),
        Deno.stat(finalDestPath),
      ]);

      if (destStat.size !== sizeBytes || sourceSha256 !== destSha256) {
        throw new Error(
          `SHA-256 or size mismatch (src=${sourceSha256}, dst=${destSha256})`,
        );
      }

      copiedVerifiedCount += 1;

      // 5. Delete from sourceDir ONLY when deleteSource is true and both rsync --checksum and SHA-256 match
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
        sha256: destSha256,
        sourceDeleted: deleteSource,
        error: null,
      });
    } catch (err) {
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
        destPath: `${destDir}/${filename}`,
        sha256: null,
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
  version: "2026.11.04.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description:
        "Scan or archive summary including per-file status, destination paths, dataless detection, xattr verification, deduplication, and SHA-256 verification",
      schema: SummaryResourceSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    scan: {
      description:
        "Read-only scan of screenshots and screen recordings, showing target date folders without modifying any files",
      arguments: z.object({
        sourceDir: z
          .string()
          .optional()
          .describe("Optional source directory override (e.g. /Users/matthew/Desktop/Screenshots)"),
        destRoot: z
          .string()
          .optional()
          .describe("Optional destination root directory override"),
      }),
      execute: async (
        args: { sourceDir?: string; destRoot?: string },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
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
        return { dataHandles: [handle] };
      },
    },
    archive: {
      description:
        "Copy eligible screenshots (< today) into configured date folders via rsync, verify with rsync --checksum and SHA-256 (deduplicating identical existing files), then optionally remove from sourceDir",
      arguments: z.object({
        dryRun: z
          .boolean()
          .default(false)
          .describe("When true, preview archive actions without creating folders or moving files"),
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
            "Optional source directory override (e.g. /Users/matthew/Desktop/Screenshots); files are scanned and removed from this directory",
          ),
        destRoot: z
          .string()
          .optional()
          .describe("Optional destination root directory override (useful for testing to a temporary folder)"),
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
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const mode = args.dryRun ? "dry-run" : "archive";
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
          throw new Error(
            `Archive completed with ${result.errorCount} verification or copy error(s); unverified source files were kept in ${result.sourceDir}.`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
