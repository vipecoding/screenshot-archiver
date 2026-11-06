/**
 * Standalone macOS Desktop screenshot and screen recording archiver.
 *
 * Uses only standard Node.js built-in modules (`node:fs/promises`, `node:path`,
 * `node:child_process`, `node:crypto`) so it runs natively in both Bun and
 * Node.js 24+ and compiles cleanly with `bun build --compile`.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { join, parse } from "node:path";

export const DEFAULT_SOURCE_DIR = "~/Desktop";
export const DEFAULT_DEST_ROOT =
  "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal/Daily";
export const DEFAULT_DATE_FORMAT = "YYYY/MM/DD";
export const DEFAULT_KEEP_TODAY = true;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_SCREENSHOT_PREFIX = "Screenshot";

export interface GlobalArgs {
  sourceDir: string;
  destRoot: string;
  dateFormat?: string;
  keepToday?: boolean;
  screenshotPrefix?: string;
}

export type CandidateStatus =
  | "ready-to-archive"
  | "skipped-today"
  | "would-archive"
  | "copied-verified"
  | "already-present-verified"
  | "archived"
  | "archived-deduplicated"
  | "error";

export interface CandidateFile {
  filename: string;
  kind: "screenshot" | "screen-recording";
  fileDate: string;
  sizeBytes: number;
  dataless: boolean;
  hasScreenCaptureXattr: boolean;
  status: CandidateStatus;
  sourcePath: string;
  destDir: string | null;
  destDirExists: boolean | null;
  destPath: string | null;
  sourceDeleted: boolean;
  error: string | null;
}

export interface BatchProgressEvent {
  runId: string;
  mode: "scan" | "dry-run" | "copy-verify" | "archive";
  fileDate: string;
  batchIndex: number;
  totalBatches: number;
  timestamp: string;
  sourceDir: string;
  destRoot: string;
  files: CandidateFile[];
  batchCopiedVerifiedCount: number;
  batchDeduplicatedCount: number;
  batchArchivedCount: number;
  batchErrorCount: number;
}

export interface SummaryResource {
  runId: string;
  mode: "scan" | "dry-run" | "copy-verify" | "archive";
  deleteSource: boolean;
  timestamp: string;
  today: string;
  sourceDir: string;
  destRoot: string;
  dateFormat: string;
  screenshotPrefix: string;
  destRootExists: boolean;
  batchSize: number;
  concurrency: number;
  dayCount: number;
  batchCount: number;
  scannedCount: number;
  matchedCount: number;
  eligibleCount: number;
  copiedVerifiedCount: number;
  deduplicatedCount: number;
  archivedCount: number;
  skippedTodayCount: number;
  skippedUnparseableCount: number;
  skippedMissingXattrCount: number;
  datalessCount: number;
  errorCount: number;
  files: CandidateFile[];
}

export interface InspectAndProcessOptions {
  deleteSource?: boolean;
  sourceDirOverride?: string;
  destRootOverride?: string;
  screenshotPrefixOverride?: string;
  batchSize?: number;
  concurrency?: number;
  runId?: string;
  beforeVerify?: (destPath: string) => Promise<void> | void;
  onBatchComplete?: (event: BatchProgressEvent) => Promise<void> | void;
}

export interface MacOSScreenshotSettings {
  sourceDir: string;
  screenshotPrefix: string;
  customLocation: string | null;
  customPrefix: string | null;
}

export interface DayPlan<T = EligibleCandidate> {
  fileDate: string;
  destDir: string;
  destDirExistsBefore: boolean;
  files: T[];
  batches: T[][];
}

export interface ArchivePlan<T = EligibleCandidate> {
  totalFiles: number;
  dayCount: number;
  batchCount: number;
  batchSize: number;
  strategy: "empty" | "single-day" | "multi-day";
  days: DayPlan<T>[];
}

export const SCREENSHOT_XATTR = "com.apple.metadata:kMDItemIsScreenCapture";
export const SCREEN_RECORDING_XATTR =
  "com.apple.metadata:kMDItemIsScreenRecording";
const XATTR_BATCH_SIZE = 200;

const SCREEN_RECORDING_FULL_REGEX =
  /^Screen Recording\s+(\d{4}-\d{2}-\d{2})\s+at\s+.+\.mov$/i;
const SCREEN_RECORDING_CANDIDATE_REGEX = /^Screen Recording\s+.+\.mov$/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildScreenshotFullRegex(screenshotPrefix: string): RegExp {
  const escaped = escapeRegExp(
    screenshotPrefix.trim() || DEFAULT_SCREENSHOT_PREFIX,
  );
  return new RegExp(
    `^${escaped}\\s+(\\d{4}-\\d{2}-\\d{2})\\s+at\\s+.+\\.(png|jpe?g|pdf|tiff?|gif|heic)$`,
    "i",
  );
}

function buildScreenshotCandidateRegex(screenshotPrefix: string): RegExp {
  const escaped = escapeRegExp(
    screenshotPrefix.trim() || DEFAULT_SCREENSHOT_PREFIX,
  );
  return new RegExp(
    `^${escaped}\\s+.+\\.(png|jpe?g|pdf|tiff?|gif|heic)$`,
    "i",
  );
}

function buildSubprocessPath(): string {
  const homebrewPrefix =
    "/opt/homebrew/opt/rsync/bin:/opt/homebrew/bin:/usr/local/bin";
  const existingPath = process.env.PATH ?? "";
  const suffix = existingPath || "/usr/bin:/bin";
  return `${homebrewPrefix}:${suffix}`;
}

/**
 * Subprocess environment prepending Homebrew `rsync` locations ahead of the
 * active `PATH` so macOS's built-in `openrsync` (2.6.9) is not selected when
 * Homebrew `rsync` (3.x+) is installed.
 */
export const SUBPROCESS_ENV: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
  PATH: buildSubprocessPath(),
};

export interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute an external binary without a shell and return `{ code, stdout, stderr }`.
 */
export function execSubprocess(
  command: string,
  args: string[],
  env: Record<string, string> = SUBPROCESS_ENV,
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errWithCode = error as NodeJS.ErrnoException & {
            code?: string | number;
          };
          if (typeof errWithCode.code === "number") {
            resolve({
              code: errWithCode.code,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
            });
            return;
          }
          reject(error);
          return;
        }
        resolve({
          code: 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

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
  const home = homeOverride ?? process.env.HOME ?? "";
  if (!home) {
    return trimmed;
  }
  return trimmed === "~" ? home : join(home, trimmed.slice(2));
}

/**
 * Auto-detect macOS screenshot folder (`location`) and custom filename prefix
 * (`name`) from `com.apple.screencapture` user defaults (or a test plist path).
 * Falls back to `~/Desktop` and `"Screenshot"` when unset.
 */
export async function detectMacOSScreenshotSettings(
  domainOrPlistPath = "com.apple.screencapture",
  homeOverride?: string,
): Promise<MacOSScreenshotSettings> {
  let customLocation: string | null = null;
  let customPrefix: string | null = null;

  try {
    const locOut = await execSubprocess(
      "/usr/bin/defaults",
      ["read", domainOrPlistPath, "location"],
      SUBPROCESS_ENV,
    );
    if (locOut.code === 0 && locOut.stdout.trim()) {
      customLocation = locOut.stdout.trim();
    }
  } catch {
    // Ignore if /usr/bin/defaults is unavailable
  }

  try {
    const nameOut = await execSubprocess(
      "/usr/bin/defaults",
      ["read", domainOrPlistPath, "name"],
      SUBPROCESS_ENV,
    );
    if (nameOut.code === 0 && nameOut.stdout.trim()) {
      customPrefix = nameOut.stdout.trim();
    }
  } catch {
    // Ignore if /usr/bin/defaults is unavailable
  }

  const sourceDir = expandHomePath(
    customLocation || DEFAULT_SOURCE_DIR,
    homeOverride,
  );
  const screenshotPrefix = customPrefix || DEFAULT_SCREENSHOT_PREFIX;

  return {
    sourceDir,
    screenshotPrefix,
    customLocation,
    customPrefix,
  };
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

/**
 * Parse a macOS screenshot or screen recording filename using explicit
 * per-kind regexes that validate both prefix and file extension together.
 */
export function parseScreenshotFilename(
  filename: string,
  referenceYear: number = new Date().getFullYear(),
  screenshotPrefix: string = DEFAULT_SCREENSHOT_PREFIX,
): {
  matchedPrefix: boolean;
  kind?: "screenshot" | "screen-recording";
  fileDate?: string;
} {
  const recMatch = SCREEN_RECORDING_FULL_REGEX.exec(filename);
  if (recMatch) {
    const normalizedDate = normalizeScreenshotDate(recMatch[1], referenceYear);
    if (!isValidDateString(normalizedDate)) {
      return { matchedPrefix: true };
    }
    return {
      matchedPrefix: true,
      kind: "screen-recording",
      fileDate: normalizedDate,
    };
  }

  const shotFullRegex = buildScreenshotFullRegex(screenshotPrefix);
  const shotMatch = shotFullRegex.exec(filename);
  if (shotMatch) {
    const normalizedDate = normalizeScreenshotDate(shotMatch[1], referenceYear);
    if (!isValidDateString(normalizedDate)) {
      return { matchedPrefix: true };
    }
    return {
      matchedPrefix: true,
      kind: "screenshot",
      fileDate: normalizedDate,
    };
  }

  // Check if the filename has a valid capture prefix + extension but an unparseable date
  // (e.g. "Screenshot bad-date.png"), while excluding unrelated files like "Screenshot notes.txt"
  // or mismatched extensions like "Screen Recording 2026-11-03 at 10.00.00.jpg".
  const shotCandidateRegex = buildScreenshotCandidateRegex(screenshotPrefix);
  if (
    SCREEN_RECORDING_CANDIDATE_REGEX.test(filename) ||
    shotCandidateRegex.test(filename)
  ) {
    const prefixUsed = screenshotPrefix.trim() || DEFAULT_SCREENSHOT_PREFIX;
    const remainder = filename.startsWith("Screen Recording ")
      ? filename.slice("Screen Recording ".length)
      : filename.slice(prefixUsed.length + 1);
    if (/\d|bad-date/i.test(remainder)) {
      return { matchedPrefix: true };
    }
  }

  return { matchedPrefix: false };
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
    const output = await execSubprocess(
      "xattr",
      ["--", ...batch],
      SUBPROCESS_ENV,
    );
    if (output.code !== 0) {
      const stderr = output.stderr.trim();
      throw new Error(
        `xattr exited with code ${output.code}: ${stderr || "unknown error"}`,
      );
    }

    const stdout = output.stdout;
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
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const info = await stat(p);
    return info.isDirectory();
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
  const output = await execSubprocess("rsync", args, SUBPROCESS_ENV);
  return { ok: output.code === 0, stderr: output.stderr.trim() };
}

/**
 * Copy multiple source files into a single destination directory (`destDir/`)
 * in a single `rsync -aXN` invocation.
 */
async function runRsyncBatchCopy(
  sourcePaths: string[],
  destDir: string,
): Promise<{ ok: boolean; stderr: string }> {
  if (sourcePaths.length === 0) return { ok: true, stderr: "" };
  const destDirWithSlash = destDir.endsWith("/") ? destDir : `${destDir}/`;
  const args = ["-aXN", "--", ...sourcePaths, destDirWithSlash];
  const output = await execSubprocess("rsync", args, SUBPROCESS_ENV);
  return { ok: output.code === 0, stderr: output.stderr.trim() };
}

/**
 * Verify multiple source files against their copies in `destDir/` in a single
 * `rsync --dry-run -aN --checksum --itemize-changes` invocation.
 */
async function runRsyncBatchChecksumVerify(
  sourcePaths: string[],
  destDir: string,
): Promise<{ ok: boolean; details: string }> {
  if (sourcePaths.length === 0) {
    return { ok: true, details: "rsync batch checksum verified" };
  }
  const destDirWithSlash = destDir.endsWith("/") ? destDir : `${destDir}/`;
  const args = [
    "--dry-run",
    "-aN",
    "--checksum",
    "--itemize-changes",
    "--",
    ...sourcePaths,
    destDirWithSlash,
  ];
  const output = await execSubprocess("rsync", args, SUBPROCESS_ENV);
  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();
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
  return { ok: true, details: "rsync batch checksum verified" };
}

async function runRsyncChecksumVerify(
  sourcePath: string,
  destPath: string,
  includeMetadata = false,
): Promise<{ ok: boolean; details: string }> {
  // Note: copy uses `rsync -aXN` to copy all extended attributes and creation
  // timestamps, and destination screen-capture xattrs are explicitly verified via
  // `getExtendedAttributesMap`. We omit `-X` during `--itemize-changes` dry-run
  // because macOS kernel-managed `com.apple.macl` / `com.apple.provenance` xattrs
  // can differ between ~/Desktop and iCloud Drive even when all user/Spotlight
  // xattrs and file contents are identical (`.f........x`).
  const args = includeMetadata
    ? [
        "--dry-run",
        "-aN",
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
  const output = await execSubprocess("rsync", args, SUBPROCESS_ENV);
  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();
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
  let output: SubprocessResult;
  try {
    output = await execSubprocess("rsync", ["--version"], env);
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

  const stdout = output.stdout;
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
 * Validate `dateFormat` pattern.
 */
export function validateDateFormat(dateFormat: string): {
  pass: boolean;
  errors?: string[];
} {
  try {
    formatDateSubpath("2026-11-05", dateFormat);
    return { pass: true };
  } catch (err) {
    return {
      pass: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

/**
 * Validate that `sourceDir` and `destRoot` exist on disk.
 */
export async function validateDirectories(
  sourceDirInput: string,
  destRootInput: string,
): Promise<{ pass: boolean; errors?: string[] }> {
  const errors: string[] = [];
  const sourceDir = expandHomePath(sourceDirInput);
  const destRoot = expandHomePath(destRootInput);
  if (!(await isDirectory(sourceDir))) {
    errors.push(`Source directory does not exist: ${sourceDir}`);
  }
  if (!(await isDirectory(destRoot))) {
    errors.push(`Destination root directory does not exist: ${destRoot}`);
  }
  return errors.length > 0 ? { pass: false, errors } : { pass: true };
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
  sourceStat: Stats,
  destDir: string,
  filename: string,
  expectedXattr: string,
  syncMetadata = true,
): Promise<{ alreadyPresent: boolean; destPath: string }> {
  const { name: base, ext } = parse(filename);
  const sourceSizeBytes = sourceStat.size;
  let candidate = join(destDir, filename);
  let n = 1;

  while (await pathExists(candidate)) {
    const destStat = await stat(candidate);
    if (destStat.isFile() && destStat.size === sourceSizeBytes) {
      const rsyncCheck = await runRsyncChecksumVerify(
        sourcePath,
        candidate,
        false,
      );
      if (rsyncCheck.ok) {
        if (syncMetadata) {
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
              stat(candidate),
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

/**
 * Run an async mapper over `items` with bounded concurrency, preserving input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effectiveConcurrency = Math.max(
    1,
    Math.min(items.length, Math.trunc(concurrency) || 1),
  );
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: effectiveConcurrency }, () =>
    runWorker(),
  );
  await Promise.all(workers);
  return results;
}

export interface EligibleCandidate {
  filename: string;
  sourcePath: string;
  kind: "screenshot" | "screen-recording";
  fileDate: string;
  expectedXattr: string;
  statInfo: Stats;
  sizeBytes: number;
  dataless: boolean;
  hasScreenCaptureXattr: boolean;
  destDir: string;
  destDirExistsBefore: boolean;
}

function buildCandidateRecord(
  item: Pick<
    EligibleCandidate,
    | "filename"
    | "kind"
    | "fileDate"
    | "sizeBytes"
    | "dataless"
    | "hasScreenCaptureXattr"
    | "sourcePath"
  >,
  overrides: {
    status: CandidateStatus;
    destDir: string | null;
    destDirExists: boolean | null;
    destPath: string | null;
    sourceDeleted?: boolean;
    error?: string | null;
  },
): CandidateFile {
  return {
    filename: item.filename,
    kind: item.kind,
    fileDate: item.fileDate,
    sizeBytes: item.sizeBytes,
    dataless: item.dataless,
    hasScreenCaptureXattr: item.hasScreenCaptureXattr,
    status: overrides.status,
    sourcePath: item.sourcePath,
    destDir: overrides.destDir,
    destDirExists: overrides.destDirExists,
    destPath: overrides.destPath,
    sourceDeleted: overrides.sourceDeleted ?? false,
    error: overrides.error ?? null,
  };
}

/**
 * Group eligible candidates by `fileDate` (`YYYY-MM-DD`) in chronological order
 * and build a day-by-day execution plan.
 *
 * - Each day with `<= batchSize` (default 50) files forms a single batch.
 * - Only when a single day has `> batchSize` files is that day split into
 *   sub-batches of `batchSize`.
 */
export function createArchivePlan<
  T extends {
    fileDate: string;
    destDir: string;
    destDirExistsBefore: boolean;
  },
>(
  candidates: readonly T[],
  batchSize: number = DEFAULT_BATCH_SIZE,
): ArchivePlan<T> {
  const effectiveBatchSize = Math.max(1, Math.trunc(batchSize));
  const byDate = new Map<string, T[]>();

  for (const candidate of candidates) {
    let group = byDate.get(candidate.fileDate);
    if (!group) {
      group = [];
      byDate.set(candidate.fileDate, group);
    }
    group.push(candidate);
  }

  const sortedDates = Array.from(byDate.keys()).sort((a, b) =>
    a.localeCompare(b),
  );

  const days: DayPlan<T>[] = [];
  let totalBatches = 0;

  for (const fileDate of sortedDates) {
    const dayFiles = byDate.get(fileDate)!;
    const batches: T[][] = [];
    for (let i = 0; i < dayFiles.length; i += effectiveBatchSize) {
      batches.push(dayFiles.slice(i, i + effectiveBatchSize));
    }
    totalBatches += batches.length;
    days.push({
      fileDate,
      destDir: dayFiles[0].destDir,
      destDirExistsBefore: dayFiles[0].destDirExistsBefore,
      files: dayFiles,
      batches,
    });
  }

  const strategy: ArchivePlan<T>["strategy"] =
    days.length === 0
      ? "empty"
      : days.length === 1
        ? "single-day"
        : "multi-day";

  return {
    totalFiles: candidates.length,
    dayCount: days.length,
    batchCount: totalBatches,
    batchSize: effectiveBatchSize,
    strategy,
    days,
  };
}

/**
 * Archive and verify a single file end-to-end (handles deduplication, `(1)`
 * collision naming, copy, checksum/xattr/birthtime verification, rollback on
 * failure, and source deletion).
 */
async function archiveSingleFile(
  item: EligibleCandidate,
  deleteSource: boolean,
  beforeVerify?: (destPath: string) => Promise<void> | void,
): Promise<CandidateFile> {
  let attemptedDestPath: string | null = null;
  let createdNewDestFile = false;
  try {
    const resolved = await resolveDestinationWithDeduplication(
      item.sourcePath,
      item.statInfo,
      item.destDir,
      item.filename,
      item.expectedXattr,
    );
    attemptedDestPath = resolved.destPath;

    if (resolved.alreadyPresent) {
      if (deleteSource) {
        await unlink(item.sourcePath);
      }
      return buildCandidateRecord(item, {
        status: deleteSource
          ? "archived-deduplicated"
          : "already-present-verified",
        destDir: item.destDir,
        destDirExists: true,
        destPath: resolved.destPath,
        sourceDeleted: deleteSource,
      });
    }

    const finalDestPath = resolved.destPath;
    createdNewDestFile = true;

    const copyResult = await runRsyncCopy(item.sourcePath, finalDestPath);
    if (!copyResult.ok) {
      throw new Error(`rsync copy failed: ${copyResult.stderr}`);
    }

    if (beforeVerify) {
      await beforeVerify(finalDestPath);
    }

    const verifyResult = await runRsyncChecksumVerify(
      item.sourcePath,
      finalDestPath,
      true,
    );
    if (!verifyResult.ok) {
      throw new Error(verifyResult.details);
    }

    const [destStat, destXattrs] = await Promise.all([
      stat(finalDestPath),
      getExtendedAttributesMap([finalDestPath]),
    ]);

    if (destStat.size !== item.sizeBytes) {
      throw new Error(
        `Size mismatch (src=${item.sizeBytes}, dst=${destStat.size})`,
      );
    }
    if (!destXattrs.get(finalDestPath)?.has(item.expectedXattr)) {
      throw new Error(
        `Destination file is missing expected extended attribute ${item.expectedXattr}: ${finalDestPath}`,
      );
    }
    if (!birthtimesMatch(item.statInfo.birthtime, destStat.birthtime)) {
      throw new Error(
        `Destination file creation timestamp mismatch: ${finalDestPath}`,
      );
    }

    createdNewDestFile = false;
    if (deleteSource) {
      await unlink(item.sourcePath);
    }

    return buildCandidateRecord(item, {
      status: deleteSource ? "archived" : "copied-verified",
      destDir: item.destDir,
      destDirExists: true,
      destPath: finalDestPath,
      sourceDeleted: deleteSource,
    });
  } catch (err) {
    if (createdNewDestFile && attemptedDestPath) {
      try {
        await rm(attemptedDestPath, { force: true });
      } catch {
        // Ignore if destination file was never created before failure
      }
    }
    return buildCandidateRecord(item, {
      status: "error",
      destDir: item.destDir,
      destDirExists: item.destDirExistsBefore,
      destPath: attemptedDestPath ?? join(item.destDir, item.filename),
      sourceDeleted: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fast 3-call batch pipeline for collision-free files in a single day's folder:
 *   1. `rsync -aXN -- <sources...> <destDir>/`
 *   2. `rsync --dry-run -aN --checksum --itemize-changes -- <sources...> <destDir>/`
 *   3. `xattr -- <destPaths...>`
 * Returns `null` if any step fails so the caller can fall back to `archiveSingleFile`.
 */
async function tryArchiveFreshBatch(
  freshItems: readonly EligibleCandidate[],
  destDir: string,
  deleteSource: boolean,
): Promise<CandidateFile[] | null> {
  if (freshItems.length === 0) return [];
  const sourcePaths = freshItems.map((item) => item.sourcePath);
  const destPaths = freshItems.map((item) => join(destDir, item.filename));

  const cleanupDestPaths = async (): Promise<void> => {
    for (const p of destPaths) {
      try {
        await rm(p, { force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  };

  try {
    const copyRes = await runRsyncBatchCopy(sourcePaths, destDir);
    if (!copyRes.ok) {
      await cleanupDestPaths();
      return null;
    }

    const verifyRes = await runRsyncBatchChecksumVerify(sourcePaths, destDir);
    if (!verifyRes.ok) {
      await cleanupDestPaths();
      return null;
    }

    const xattrMap = await getExtendedAttributesMap(destPaths);
    for (let i = 0; i < freshItems.length; i += 1) {
      const item = freshItems[i];
      const destPath = destPaths[i];
      if (!xattrMap.get(destPath)?.has(item.expectedXattr)) {
        await cleanupDestPaths();
        return null;
      }
    }
  } catch {
    await cleanupDestPaths();
    return null;
  }

  // All files in `freshItems` are copied and verified; now remove sources if requested
  const results: CandidateFile[] = [];
  for (let i = 0; i < freshItems.length; i += 1) {
    const item = freshItems[i];
    const destPath = destPaths[i];
    try {
      if (deleteSource) {
        await unlink(item.sourcePath);
      }
      results.push(
        buildCandidateRecord(item, {
          status: deleteSource ? "archived" : "copied-verified",
          destDir,
          destDirExists: true,
          destPath,
          sourceDeleted: deleteSource,
        }),
      );
    } catch (err) {
      results.push(
        buildCandidateRecord(item, {
          status: "error",
          destDir,
          destDirExists: true,
          destPath,
          sourceDeleted: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return results;
}

/**
 * Execute a single day-batch by partitioning into collision-free `fresh` files
 * (eligible for the 3-subprocess batch fast path) and `colliding` files
 * (handled individually for deduplication or `(1)` suffixing).
 */
async function executeDayArchiveBatch(
  batch: readonly EligibleCandidate[],
  destDir: string,
  existingNamesInDayDir: Set<string>,
  deleteSource: boolean,
  concurrency: number,
  beforeVerify?: (destPath: string) => Promise<void> | void,
): Promise<CandidateFile[]> {
  const results = new Array<CandidateFile>(batch.length);
  const freshIndices: number[] = [];
  const collidingIndices: number[] = [];

  for (let i = 0; i < batch.length; i += 1) {
    if (existingNamesInDayDir.has(batch[i].filename)) {
      collidingIndices.push(i);
    } else {
      freshIndices.push(i);
    }
  }

  if (freshIndices.length > 0) {
    const freshItems = freshIndices.map((idx) => batch[idx]);
    const fastResults = !beforeVerify
      ? await tryArchiveFreshBatch(freshItems, destDir, deleteSource)
      : null;

    const resolvedFreshResults =
      fastResults ??
      (await mapWithConcurrency(freshItems, concurrency, (item) =>
        archiveSingleFile(item, deleteSource, beforeVerify),
      ));

    for (let j = 0; j < freshIndices.length; j += 1) {
      const result = resolvedFreshResults[j];
      results[freshIndices[j]] = result;
      if (result.status !== "error") {
        existingNamesInDayDir.add(result.filename);
      }
    }
  }

  if (collidingIndices.length > 0) {
    const collidingItems = collidingIndices.map((idx) => batch[idx]);
    const collidingResults = await mapWithConcurrency(
      collidingItems,
      concurrency,
      (item) => archiveSingleFile(item, deleteSource, beforeVerify),
    );
    for (let j = 0; j < collidingIndices.length; j += 1) {
      results[collidingIndices[j]] = collidingResults[j];
    }
  }

  return results;
}

/**
 * Scan or archive screenshots according to `mode` using a 3-stage
 * Discover -> Plan by Day -> Execute pipeline.
 */
export async function inspectAndProcess(
  globalArgs: GlobalArgs,
  mode: "scan" | "dry-run" | "archive",
  todayOverride?: string,
  options?: InspectAndProcessOptions,
): Promise<SummaryResource> {
  const dateFormat = globalArgs.dateFormat ?? DEFAULT_DATE_FORMAT;
  const keepToday = globalArgs.keepToday ?? DEFAULT_KEEP_TODAY;
  const screenshotPrefix =
    options?.screenshotPrefixOverride ||
    globalArgs.screenshotPrefix ||
    DEFAULT_SCREENSHOT_PREFIX;
  const sourceDir = expandHomePath(
    options?.sourceDirOverride || globalArgs.sourceDir,
  );
  const destRoot = expandHomePath(
    options?.destRootOverride || globalArgs.destRoot,
  );
  const deleteSource = options?.deleteSource ?? true;
  const batchSize = Math.max(
    1,
    Math.trunc(options?.batchSize ?? DEFAULT_BATCH_SIZE),
  );
  const concurrency = Math.max(
    1,
    Math.trunc(options?.concurrency ?? DEFAULT_CONCURRENCY),
  );
  const runId = options?.runId ?? randomUUID();

  formatDateSubpath("2026-11-05", dateFormat);

  if (!(await isDirectory(sourceDir))) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }
  const destRootExists = await isDirectory(destRoot);
  if (!destRootExists && mode === "archive") {
    throw new Error(
      `Destination root directory is not available: ${destRoot}. Aborting safely without touching any files.`,
    );
  }

  const effectiveMode: "scan" | "dry-run" | "copy-verify" | "archive" =
    mode === "archive" && !deleteSource ? "copy-verify" : mode;

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

  // ============================================================================
  // Stage 1: Discover
  // ============================================================================
  const entries = await readdir(sourceDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parsedCandidates: Array<{
    filename: string;
    sourcePath: string;
    kind: "screenshot" | "screen-recording";
    fileDate: string;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    scannedCount += 1;
    const filename = entry.name;
    const parsed = parseScreenshotFilename(
      filename,
      referenceYear,
      screenshotPrefix,
    );
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

  const destDirExistenceCache = new Map<string, boolean>();
  async function checkDestDirExistsCached(destDir: string): Promise<boolean> {
    const cached = destDirExistenceCache.get(destDir);
    if (cached !== undefined) return cached;
    const exists = await isDirectory(destDir);
    destDirExistenceCache.set(destDir, exists);
    return exists;
  }

  const eligibleCandidates: EligibleCandidate[] = [];

  for (const { filename, sourcePath, kind, fileDate } of parsedCandidates) {
    const expectedXattr =
      kind === "screen-recording" ? SCREEN_RECORDING_XATTR : SCREENSHOT_XATTR;
    const fileXattrs = xattrMap.get(sourcePath);
    const hasScreenCaptureXattr = Boolean(fileXattrs?.has(expectedXattr));

    if (!hasScreenCaptureXattr) {
      skippedMissingXattrCount += 1;
      continue;
    }

    matchedCount += 1;

    const statInfo = await stat(sourcePath);
    const sizeBytes = statInfo.size;
    // On modern macOS APFS + FileProvider, evicted dataless files report logical size > 0
    // with 0 allocated blocks on disk.
    const dataless = sizeBytes > 0 && statInfo.blocks === 0;
    if (dataless) {
      datalessCount += 1;
    }

    if (keepToday && fileDate >= today) {
      skippedTodayCount += 1;
      files.push(
        buildCandidateRecord(
          {
            filename,
            kind,
            fileDate,
            sizeBytes,
            dataless,
            hasScreenCaptureXattr,
            sourcePath,
          },
          {
            status: "skipped-today",
            destDir: null,
            destDirExists: null,
            destPath: null,
          },
        ),
      );
      continue;
    }

    eligibleCount += 1;
    const dateSubpath = formatDateSubpath(fileDate, dateFormat);
    const destDir = join(destRoot, dateSubpath);
    const destDirExistsBefore = await checkDestDirExistsCached(destDir);

    eligibleCandidates.push({
      filename,
      sourcePath,
      kind,
      fileDate,
      expectedXattr,
      statInfo,
      sizeBytes,
      dataless,
      hasScreenCaptureXattr,
      destDir,
      destDirExistsBefore,
    });
  }

  // ============================================================================
  // Stage 2: Build Day-by-Day Plan
  // ============================================================================
  const plan = createArchivePlan(eligibleCandidates, batchSize);

  // ============================================================================
  // Stage 3: Execute Plan Day-by-Day
  // ============================================================================
  let globalBatchIndex = 0;

  for (const dayPlan of plan.days) {
    if (mode === "scan" || mode === "dry-run") {
      for (const batch of dayPlan.batches) {
        globalBatchIndex += 1;
        const batchResults = await mapWithConcurrency(
          batch,
          concurrency,
          async (item) => {
            const resolved = item.destDirExistsBefore
              ? await resolveDestinationWithDeduplication(
                  item.sourcePath,
                  item.statInfo,
                  item.destDir,
                  item.filename,
                  item.expectedXattr,
                  false,
                )
              : {
                  alreadyPresent: false,
                  destPath: join(item.destDir, item.filename),
                };
            return { item, resolved };
          },
        );

        let batchDeduplicated = 0;
        const batchCandidateFiles = batchResults.map(({ item, resolved }) => {
          if (resolved.alreadyPresent) {
            deduplicatedCount += 1;
            batchDeduplicated += 1;
          }
          return buildCandidateRecord(item, {
            status: mode === "scan" ? "ready-to-archive" : "would-archive",
            destDir: item.destDir,
            destDirExists: item.destDirExistsBefore,
            destPath: resolved.destPath,
          });
        });

        files.push(...batchCandidateFiles);

        if (options?.onBatchComplete) {
          await options.onBatchComplete({
            runId,
            mode: effectiveMode,
            fileDate: dayPlan.fileDate,
            batchIndex: globalBatchIndex,
            totalBatches: plan.batchCount,
            timestamp: new Date().toISOString(),
            sourceDir,
            destRoot,
            files: batchCandidateFiles,
            batchCopiedVerifiedCount: 0,
            batchDeduplicatedCount: batchDeduplicated,
            batchArchivedCount: 0,
            batchErrorCount: 0,
          });
        }
      }
      continue;
    }

    // Mode === "archive":
    // 1. Ensure this day's destination directory exists once for the entire day
    let dayMkdirError: string | null = null;
    const existingNamesInDayDir = new Set<string>();
    try {
      await mkdir(dayPlan.destDir, { recursive: true });
      for (const name of await readdir(dayPlan.destDir)) {
        existingNamesInDayDir.add(name);
      }
    } catch (err) {
      dayMkdirError = err instanceof Error ? err.message : String(err);
    }

    // 2. Execute each batch in this day
    for (const batch of dayPlan.batches) {
      globalBatchIndex += 1;

      const batchCandidateFiles = dayMkdirError
        ? batch.map((item) =>
            buildCandidateRecord(item, {
              status: "error",
              destDir: item.destDir,
              destDirExists: item.destDirExistsBefore,
              destPath: join(item.destDir, item.filename),
              error: `mkdir failed for ${item.destDir}: ${dayMkdirError}`,
            }),
          )
        : await executeDayArchiveBatch(
            batch,
            dayPlan.destDir,
            existingNamesInDayDir,
            deleteSource,
            concurrency,
            options?.beforeVerify,
          );

      let batchCopiedVerified = 0;
      let batchDeduplicated = 0;
      let batchArchived = 0;
      let batchErrors = 0;

      for (const record of batchCandidateFiles) {
        files.push(record);
        if (record.status === "error") {
          errorCount += 1;
          batchErrors += 1;
        } else if (
          record.status === "archived-deduplicated" ||
          record.status === "already-present-verified"
        ) {
          deduplicatedCount += 1;
          batchDeduplicated += 1;
          if (record.sourceDeleted) {
            archivedCount += 1;
            batchArchived += 1;
          }
        } else if (
          record.status === "archived" ||
          record.status === "copied-verified"
        ) {
          copiedVerifiedCount += 1;
          batchCopiedVerified += 1;
          if (record.sourceDeleted) {
            archivedCount += 1;
            batchArchived += 1;
          }
        }
      }

      if (options?.onBatchComplete) {
        await options.onBatchComplete({
          runId,
          mode: effectiveMode,
          fileDate: dayPlan.fileDate,
          batchIndex: globalBatchIndex,
          totalBatches: plan.batchCount,
          timestamp: new Date().toISOString(),
          sourceDir,
          destRoot,
          files: batchCandidateFiles,
          batchCopiedVerifiedCount: batchCopiedVerified,
          batchDeduplicatedCount: batchDeduplicated,
          batchArchivedCount: batchArchived,
          batchErrorCount: batchErrors,
        });
      }
    }
  }

  files.sort((a, b) => a.filename.localeCompare(b.filename));

  return {
    runId,
    mode: effectiveMode,
    deleteSource: mode === "archive" ? deleteSource : false,
    timestamp: new Date().toISOString(),
    today,
    sourceDir,
    destRoot,
    dateFormat,
    screenshotPrefix,
    destRootExists,
    batchSize,
    concurrency,
    dayCount: plan.dayCount,
    batchCount: plan.batchCount,
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
