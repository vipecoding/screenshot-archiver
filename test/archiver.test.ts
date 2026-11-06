import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BatchProgressEvent,
  type CandidateFile,
  checkModernRsync,
  createArchivePlan,
  detectMacOSScreenshotSettings,
  execSubprocess,
  expandHomePath,
  formatDateSubpath,
  getExtendedAttributesMap,
  getLocalToday,
  inspectAndProcess,
  isValidDateString,
  normalizeScreenshotDate,
  parseScreenshotFilename,
  SUBPROCESS_ENV,
  validateDateFormat,
  validateDirectories,
} from "../src/archiver.ts";
import {
  appendBatchAudit,
  formatAuditHistory,
  readAuditHistory,
  rotateLogIfNeeded,
} from "../src/audit.ts";
import { runCli } from "../src/cli.ts";

async function setXattr(
  filePath: string,
  attrName: string,
  value = "1",
): Promise<void> {
  const out = await execSubprocess(
    "xattr",
    ["-w", attrName, value, "--", filePath],
    SUBPROCESS_ENV,
  );
  if (out.code !== 0) {
    throw new Error(
      `Failed to set xattr ${attrName} on ${filePath}: ${out.stderr}`,
    );
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function makeTempTestDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

describe("screenshot-archiver", () => {
  test("formatDateSubpath and expandHomePath validate patterns and expand tilde", () => {
    expect(formatDateSubpath("2026-11-03", "YYYY/MM/DD")).toBe("2026/11/03");
    expect(formatDateSubpath("2026-11-03", "YYYY-MM-DD")).toBe("2026-11-03");
    expect(formatDateSubpath("2026-11-03", "YYYY/MM/YYYY-MM-DD")).toBe(
      "2026/11/2026-11-03",
    );
    expect(formatDateSubpath("2026-11-03", "YY/MM/DD")).toBe("26/11/03");

    for (const invalidFormat of [
      "../YYYY/MM/DD",
      "YYYY//MM/DD",
      "YYYY\\MM\\DD",
      "yyyy/mm/dd",
      "screenshots",
      "",
      "/",
    ]) {
      expect(() => formatDateSubpath("2026-11-03", invalidFormat)).toThrow();
    }

    expect(expandHomePath("~/Desktop", "/Users/alice")).toBe(
      "/Users/alice/Desktop",
    );
    expect(expandHomePath("~", "/Users/alice")).toBe("/Users/alice");
    expect(expandHomePath("/Users/alice/Desktop", "/Users/alice")).toBe(
      "/Users/alice/Desktop",
    );
  });

  test("parseScreenshotFilename matches screenshots, recordings, custom prefixes, and bounds Buddhist years", () => {
    const s1 = parseScreenshotFilename(
      "Screenshot 2026-11-03 at 10.15.20 AM.png",
    );
    expect(s1.matchedPrefix).toBe(true);
    expect(s1.kind).toBe("screenshot");
    expect(s1.fileDate).toBe("2026-11-03");

    const s2 = parseScreenshotFilename(
      "Screen Shot 2026-02-28 at 14.05.00.png",
    );
    expect(s2.matchedPrefix).toBe(false);

    // Custom screenshot prefix configured via com.apple.screencapture name
    const customPrefixMatch = parseScreenshotFilename(
      "Screen Shot 2026-02-28 at 14.05.00.png",
      2026,
      "Screen Shot",
    );
    expect(customPrefixMatch.matchedPrefix).toBe(true);
    expect(customPrefixMatch.kind).toBe("screenshot");
    expect(customPrefixMatch.fileDate).toBe("2026-02-28");

    const sr = parseScreenshotFilename(
      "Screen Recording 2026-11-01 at 09.30.00.mov",
    );
    expect(sr.matchedPrefix).toBe(true);
    expect(sr.kind).toBe("screen-recording");
    expect(sr.fileDate).toBe("2026-11-01");

    const buddhist = parseScreenshotFilename(
      "Screenshot 2569-03-04 at 10.01.31 PM.png",
      2026,
    );
    expect(buddhist.matchedPrefix).toBe(true);
    expect(buddhist.kind).toBe("screenshot");
    expect(buddhist.fileDate).toBe("2026-03-04");

    // Out-of-bounds year (> referenceYear + 545) must not be subtracted by 543
    expect(normalizeScreenshotDate("9999-01-01", 2026)).toBe("9999-01-01");

    const prefixed = parseScreenshotFilename(
      "before Screenshot 2026-02-04 at 2.29.43 pm.png",
      2026,
    );
    expect(prefixed.matchedPrefix).toBe(false);

    for (const ext of [
      "png",
      "jpg",
      "jpeg",
      "pdf",
      "tiff",
      "tif",
      "gif",
      "heic",
    ]) {
      const valid = parseScreenshotFilename(
        `Screenshot 2026-11-03 at 10.15.20 AM.${ext}`,
        2026,
      );
      expect(valid.matchedPrefix).toBe(true);
      expect(valid.kind).toBe("screenshot");
      expect(valid.fileDate).toBe("2026-11-03");
    }

    const wrongScreenshotExt = parseScreenshotFilename(
      "Screenshot 2026-11-03 at 10.15.20 AM.zip",
      2026,
    );
    expect(wrongScreenshotExt.matchedPrefix).toBe(false);

    const nonScreenshotNotes = parseScreenshotFilename(
      "Screenshot notes.txt",
      2026,
    );
    expect(nonScreenshotNotes.matchedPrefix).toBe(false);

    const wrongRecordingExtMp4 = parseScreenshotFilename(
      "Screen Recording 2026-11-03 at 10.15.20 AM.mp4",
      2026,
    );
    expect(wrongRecordingExtMp4.matchedPrefix).toBe(false);

    // A "Screen Recording" with a screenshot image extension (.jpg / .png) must be rejected
    const wrongRecordingExtJpg = parseScreenshotFilename(
      "Screen Recording 2026-11-03 at 10.15.20 AM.jpg",
      2026,
    );
    expect(wrongRecordingExtJpg.matchedPrefix).toBe(false);

    const badDate = parseScreenshotFilename(
      "Screenshot 2026-02-30 at 10.00.00.png",
    );
    expect(badDate.matchedPrefix).toBe(true);
    expect(badDate.fileDate).toBeUndefined();

    const corruptedName = parseScreenshotFilename("Screenshot corrupted.png");
    expect(corruptedName.matchedPrefix).toBe(true);
    expect(corruptedName.fileDate).toBeUndefined();

    const nonMatch = parseScreenshotFilename("vacation-photo.jpg");
    expect(nonMatch.matchedPrefix).toBe(false);
    expect(isValidDateString("2026-11-04")).toBe(true);
    expect(isValidDateString("2026-02-29")).toBe(false);
  });

  test("detectMacOSScreenshotSettings reads custom location and name from plist and falls back to defaults", async () => {
    const tempRoot = await makeTempTestDir("screenshot-defaults-test-");
    try {
      const customPlist = `${tempRoot}/com.apple.screencapture.plist`;
      await execSubprocess("/usr/bin/defaults", [
        "write",
        customPlist,
        "location",
        "~/Desktop/CustomShots",
      ]);
      await execSubprocess("/usr/bin/defaults", [
        "write",
        customPlist,
        "name",
        "Snap",
      ]);

      const detected = await detectMacOSScreenshotSettings(
        customPlist,
        "/Users/alice",
      );
      expect(detected.customLocation).toBe("~/Desktop/CustomShots");
      expect(detected.sourceDir).toBe("/Users/alice/Desktop/CustomShots");
      expect(detected.customPrefix).toBe("Snap");
      expect(detected.screenshotPrefix).toBe("Snap");

      const fallback = await detectMacOSScreenshotSettings(
        `${tempRoot}/nonexistent.plist`,
        "/Users/alice",
      );
      expect(fallback.customLocation).toBeNull();
      expect(fallback.sourceDir).toBe("/Users/alice/Desktop");
      expect(fallback.customPrefix).toBeNull();
      expect(fallback.screenshotPrefix).toBe("Screenshot");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("getExtendedAttributesMap handles single-file colons, batching, and missing files", async () => {
    const tempRoot = await makeTempTestDir("screenshot-xattr-test-");
    try {
      const f1 = `${tempRoot}/one.png`;
      const f2 = `${tempRoot}/two.png`;
      const f3 = `${tempRoot}/three.png`;
      await writeFile(f1, "1", "utf8");
      await writeFile(f2, "2", "utf8");
      await writeFile(f3, "3", "utf8");

      const colonAttr = "com.example.custom: label: with spaces";
      await setXattr(f1, colonAttr, "val");
      await setXattr(f1, "com.apple.metadata:kMDItemIsScreenCapture", "1");
      await setXattr(f2, "com.apple.metadata:kMDItemIsScreenCapture", "1");
      await setXattr(f3, "com.apple.metadata:kMDItemIsScreenRecording", "1");

      // Single file with ": " inside the attribute name
      const singleMap = await getExtendedAttributesMap([f1]);
      expect(singleMap.get(f1)?.has(colonAttr)).toBe(true);
      expect(
        singleMap.get(f1)?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      ).toBe(true);

      // Chunked multi-file batching (batchSize = 2 across 3 files)
      const batchedMap = await getExtendedAttributesMap([f1, f2, f3], 2);
      expect(
        batchedMap.get(f1)?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      ).toBe(true);
      expect(
        batchedMap.get(f2)?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      ).toBe(true);
      expect(
        batchedMap.get(f3)?.has("com.apple.metadata:kMDItemIsScreenRecording"),
      ).toBe(true);

      // Non-existent file surfaces non-zero exit code error
      await expect(
        getExtendedAttributesMap([`${tempRoot}/missing.png`]),
      ).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("validateDateFormat, validateDirectories, and checkModernRsync validate environment", async () => {
    const tempRoot = await makeTempTestDir("screenshot-checks-test-");
    try {
      expect(validateDateFormat("YYYY/MM/DD").pass).toBe(true);
      expect(validateDateFormat("yyyy/mm/dd").pass).toBe(false);

      const dirsExist = await validateDirectories(tempRoot, tempRoot);
      expect(dirsExist.pass).toBe(true);

      const dirsMissing = await validateDirectories(
        `${tempRoot}/missing-src`,
        `${tempRoot}/missing-dst`,
      );
      expect(dirsMissing.pass).toBe(false);
      expect(dirsMissing.errors?.length).toBe(2);

      const modernRsyncPass = await checkModernRsync();
      expect(modernRsyncPass.pass).toBe(true);

      const openRsyncFail = await checkModernRsync({ PATH: "/usr/bin:/bin" });
      expect(openRsyncFail.pass).toBe(false);

      const missingRsyncFail = await checkModernRsync({ PATH: "/nonexistent" });
      expect(missingRsyncFail.pass).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("scan, dry-run, and archive end-to-end with rsync checksum, xattr, and birthtime verification", async () => {
    const tempRoot = await makeTempTestDir("screenshot-archiver-test-");
    try {
      const sourceDir = `${tempRoot}/Desktop`;
      const destRoot = `${tempRoot}/Daily`;
      await mkdir(sourceDir, { recursive: true });

      const today = getLocalToday();
      const yesterdayShot = "Screenshot 2020-11-03 at 10.00.00 AM.png";
      const yesterdayRec = "Screen Recording 2020-11-02 at 18.30.00.mov";
      const fakeShotWithoutXattr = "Screenshot 2020-11-01 at 12.00.00 PM.png";
      const unparseableShot = "Screenshot bad-date.png";
      const todayShot = `Screenshot ${today} at 08.00.00 AM.png`;
      const otherFile = "notes.md";

      await writeFile(
        `${sourceDir}/${yesterdayShot}`,
        "png-bytes-12345",
        "utf8",
      );
      await writeFile(
        `${sourceDir}/${yesterdayRec}`,
        "mov-bytes-67890",
        "utf8",
      );
      await writeFile(
        `${sourceDir}/${fakeShotWithoutXattr}`,
        "not-a-real-screenshot",
        "utf8",
      );
      await writeFile(`${sourceDir}/${unparseableShot}`, "unparseable", "utf8");
      await writeFile(`${sourceDir}/${todayShot}`, "today-png-bytes", "utf8");
      await writeFile(`${sourceDir}/${otherFile}`, "keep-me", "utf8");

      await setXattr(
        `${sourceDir}/${yesterdayShot}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );
      await setXattr(
        `${sourceDir}/${todayShot}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );
      await setXattr(
        `${sourceDir}/${yesterdayRec}`,
        "com.apple.metadata:kMDItemIsScreenRecording",
      );

      const sourceShotStat = await stat(`${sourceDir}/${yesterdayShot}`);

      // 1. Read-only scan when destRoot does NOT exist yet
      const scanResult = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "scan",
      );

      expect(scanResult.mode).toBe("scan");
      expect(scanResult.destRootExists).toBe(false);
      expect(scanResult.scannedCount).toBe(6);
      expect(scanResult.matchedCount).toBe(3);
      expect(scanResult.skippedUnparseableCount).toBe(1);
      expect(scanResult.skippedMissingXattrCount).toBe(1);
      expect(scanResult.eligibleCount).toBe(2);
      expect(scanResult.dayCount).toBe(2);
      expect(scanResult.batchCount).toBe(2);
      expect(scanResult.skippedTodayCount).toBe(1);
      expect(scanResult.archivedCount).toBe(0);

      // 2. Dry-run when destRoot exists
      await mkdir(destRoot, { recursive: true });
      const dryRunResult = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "dry-run",
      );
      expect(dryRunResult.mode).toBe("dry-run");
      expect(dryRunResult.destRootExists).toBe(true);
      expect(
        dryRunResult.files.filter(
          (f: CandidateFile) => f.status === "would-archive",
        ).length,
      ).toBe(2);
      expect(await fileExists(`${destRoot}/2020/11/03/${yesterdayShot}`)).toBe(
        false,
      );

      // 3. Full archive
      const archiveResult = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "archive",
      );

      expect(archiveResult.archivedCount).toBe(2);
      expect(archiveResult.errorCount).toBe(0);

      const archivedDest = `${destRoot}/2020/11/03/${yesterdayShot}`;
      const archivedRecDest = `${destRoot}/2020/11/02/${yesterdayRec}`;
      expect(await readFile(archivedDest, "utf8")).toBe("png-bytes-12345");

      const destXattrs = await getExtendedAttributesMap([archivedDest]);
      expect(
        destXattrs
          .get(archivedDest)
          ?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      ).toBe(true);

      const destShotStat = await stat(archivedDest);
      expect(
        Math.abs(
          sourceShotStat.birthtime.getTime() - destShotStat.birthtime.getTime(),
        ),
      ).toBeLessThanOrEqual(1000);

      expect(await readFile(archivedRecDest, "utf8")).toBe("mov-bytes-67890");
      expect(await fileExists(`${sourceDir}/${yesterdayShot}`)).toBe(false);
      expect(await readFile(`${sourceDir}/${todayShot}`, "utf8")).toBe(
        "today-png-bytes",
      );
      expect(
        await readFile(`${sourceDir}/${fakeShotWithoutXattr}`, "utf8"),
      ).toBe("not-a-real-screenshot");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("collision suffix is added only when existing file has different content, and identical content is deduplicated", async () => {
    const tempRoot = await makeTempTestDir("screenshot-dedup-test-");
    try {
      const sourceDir = `${tempRoot}/Desktop`;
      const destRoot = `${tempRoot}/Daily`;
      const existingDir = `${destRoot}/2020/11/03`;
      await mkdir(sourceDir, { recursive: true });
      await mkdir(existingDir, { recursive: true });

      const diffFilename = "Screenshot 2020-11-03 at 10.00.00 AM.png";
      const sameFilename = "Screenshot 2020-11-03 at 11.00.00 AM.png";

      await writeFile(
        `${existingDir}/${diffFilename}`,
        "original-file-v1",
        "utf8",
      );
      await writeFile(
        `${existingDir}/${sameFilename}`,
        "identical-bytes-xyz",
        "utf8",
      );
      const sameInodeBefore = (await stat(`${existingDir}/${sameFilename}`))
        .ino;

      await writeFile(
        `${sourceDir}/${diffFilename}`,
        "second-file-different-bytes",
        "utf8",
      );
      await writeFile(
        `${sourceDir}/${sameFilename}`,
        "identical-bytes-xyz",
        "utf8",
      );
      await setXattr(
        `${sourceDir}/${diffFilename}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );
      await setXattr(
        `${sourceDir}/${sameFilename}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );

      const scanPreview = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "scan",
        "2020-11-04",
      );
      expect(scanPreview.deduplicatedCount).toBe(1);
      const previewDiff = scanPreview.files.find(
        (f: CandidateFile) => f.filename === diffFilename,
      );
      const previewSame = scanPreview.files.find(
        (f: CandidateFile) => f.filename === sameFilename,
      );
      expect(previewDiff?.destPath).toBe(
        `${existingDir}/Screenshot 2020-11-03 at 10.00.00 AM (1).png`,
      );
      expect(previewSame?.destPath).toBe(`${existingDir}/${sameFilename}`);

      const result = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "archive",
        "2020-11-04",
      );

      expect(result.copiedVerifiedCount).toBe(1);
      expect(result.deduplicatedCount).toBe(1);
      expect(result.archivedCount).toBe(2);

      const collidedPath = `${existingDir}/Screenshot 2020-11-03 at 10.00.00 AM (1).png`;
      expect(await readFile(`${existingDir}/${diffFilename}`, "utf8")).toBe(
        "original-file-v1",
      );
      expect(await readFile(collidedPath, "utf8")).toBe(
        "second-file-different-bytes",
      );

      expect(
        await fileExists(
          `${existingDir}/Screenshot 2020-11-03 at 11.00.00 AM (1).png`,
        ),
      ).toBe(false);

      const sameInodeAfter = (await stat(`${existingDir}/${sameFilename}`)).ino;
      expect(sameInodeAfter).toBe(sameInodeBefore);

      const dedupXattrs = await getExtendedAttributesMap([
        `${existingDir}/${sameFilename}`,
      ]);
      expect(
        dedupXattrs
          .get(`${existingDir}/${sameFilename}`)
          ?.has("com.apple.metadata:kMDItemIsScreenCapture"),
      ).toBe(true);

      expect(await fileExists(`${sourceDir}/${diffFilename}`)).toBe(false);
      expect(await fileExists(`${sourceDir}/${sameFilename}`)).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("verification failure cleans up corrupted destination file, keeps source, and reports error details", async () => {
    const tempRoot = await makeTempTestDir("screenshot-verify-fail-test-");
    try {
      const sourceDir = `${tempRoot}/Desktop`;
      const destRoot = `${tempRoot}/Daily`;
      await mkdir(sourceDir, { recursive: true });
      await mkdir(destRoot, { recursive: true });

      const filename = "Screenshot 2020-11-03 at 10.00.00 AM.png";
      await writeFile(
        `${sourceDir}/${filename}`,
        "good-screenshot-bytes",
        "utf8",
      );
      await setXattr(
        `${sourceDir}/${filename}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );

      // 1. Simulate post-copy corruption via beforeVerify hook
      const failedRun = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "archive",
        "2020-11-04",
        {
          beforeVerify: async (destPath) => {
            await writeFile(destPath, "corrupted-destination-bytes", "utf8");
          },
        },
      );

      expect(failedRun.errorCount).toBe(1);
      expect(failedRun.archivedCount).toBe(0);
      expect(failedRun.files[0].status).toBe("error");
      expect(failedRun.files[0].destPath).toBe(
        `${destRoot}/2020/11/03/${filename}`,
      );
      expect(await fileExists(`${sourceDir}/${filename}`)).toBe(true);
      expect(await fileExists(`${destRoot}/2020/11/03/${filename}`)).toBe(
        false,
      );

      // 2. Subsequent retry archives cleanly to primary path (not (1))
      const retryRun = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "archive",
        "2020-11-04",
      );
      expect(retryRun.errorCount).toBe(0);
      expect(retryRun.archivedCount).toBe(1);
      expect(await readFile(`${destRoot}/2020/11/03/${filename}`, "utf8")).toBe(
        "good-screenshot-bytes",
      );
      expect(
        await fileExists(
          `${destRoot}/2020/11/03/Screenshot 2020-11-03 at 10.00.00 AM (1).png`,
        ),
      ).toBe(false);

      // 3. Partial run failure when one date directory is read-only
      const okFile = "Screenshot 2020-11-02 at 09.00.00 AM.png";
      const errFile = "Screenshot 2020-11-03 at 11.00.00 AM.png";
      await writeFile(`${sourceDir}/${okFile}`, "ok-bytes", "utf8");
      await writeFile(`${sourceDir}/${errFile}`, "err-bytes", "utf8");
      await setXattr(
        `${sourceDir}/${okFile}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );
      await setXattr(
        `${sourceDir}/${errFile}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );

      await chmod(`${destRoot}/2020/11/03`, 0o555);
      let partialResult;
      try {
        partialResult = await inspectAndProcess(
          {
            sourceDir,
            destRoot,
            dateFormat: "YYYY/MM/DD",
            keepToday: true,
          },
          "archive",
          "2020-11-04",
        );
      } finally {
        await chmod(`${destRoot}/2020/11/03`, 0o755);
      }

      expect(partialResult.archivedCount).toBe(1);
      expect(partialResult.errorCount).toBe(1);
      expect(await fileExists(`${sourceDir}/${okFile}`)).toBe(false);
      expect(await fileExists(`${sourceDir}/${errFile}`)).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("sourceDir override scans and deletes from overridden directory, leaving default Desktop untouched", async () => {
    const tempRoot = await makeTempTestDir("screenshot-sourcedir-override-");
    try {
      const defaultDesktop = `${tempRoot}/Desktop`;
      const subfolderSource = `${tempRoot}/Desktop/Screenshots`;
      const destRoot = `${tempRoot}/Daily`;
      await mkdir(defaultDesktop, { recursive: true });
      await mkdir(subfolderSource, { recursive: true });
      await mkdir(destRoot, { recursive: true });

      const desktopFile = "Screenshot 2020-11-03 at 09.00.00 AM.png";
      const subfolderFile = "Screenshot 2020-02-18 at 09.18.04 PM.png";

      await writeFile(
        `${defaultDesktop}/${desktopFile}`,
        "on-main-desktop",
        "utf8",
      );
      await writeFile(
        `${subfolderSource}/${subfolderFile}`,
        "in-screenshots-subfolder",
        "utf8",
      );
      await setXattr(
        `${defaultDesktop}/${desktopFile}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );
      await setXattr(
        `${subfolderSource}/${subfolderFile}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );

      await inspectAndProcess(
        {
          sourceDir: defaultDesktop,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "archive",
        "2020-11-04",
        {
          sourceDirOverride: subfolderSource,
        },
      );

      expect(
        await readFile(`${destRoot}/2020/02/18/${subfolderFile}`, "utf8"),
      ).toBe("in-screenshots-subfolder");
      expect(await fileExists(`${subfolderSource}/${subfolderFile}`)).toBe(
        false,
      );
      expect(await fileExists(`${defaultDesktop}/${desktopFile}`)).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("deleteSource=false copies and checksum-verifies without deleting Desktop source", async () => {
    const tempRoot = await makeTempTestDir("screenshot-copy-verify-test-");
    try {
      const sourceDir = `${tempRoot}/Desktop`;
      const realDest = `${tempRoot}/Daily`;
      const tempDest = `${tempRoot}/TempArchive`;
      await mkdir(sourceDir, { recursive: true });
      await mkdir(realDest, { recursive: true });
      await mkdir(tempDest, { recursive: true });

      const filename = "Screenshot 2020-11-03 at 10.00.00 AM.png";
      await writeFile(
        `${sourceDir}/${filename}`,
        "verify-keep-source-bytes",
        "utf8",
      );
      await setXattr(
        `${sourceDir}/${filename}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );

      const summary = await inspectAndProcess(
        {
          sourceDir,
          destRoot: realDest,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "archive",
        "2020-11-04",
        {
          deleteSource: false,
          destRootOverride: tempDest,
        },
      );

      expect(summary.mode).toBe("copy-verify");
      expect(summary.copiedVerifiedCount).toBe(1);
      expect(summary.archivedCount).toBe(0);
      expect(await readFile(`${sourceDir}/${filename}`, "utf8")).toBe(
        "verify-keep-source-bytes",
      );
      expect(await readFile(`${tempDest}/2020/11/03/${filename}`, "utf8")).toBe(
        "verify-keep-source-bytes",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("createArchivePlan groups by day and only sub-batches within a day when day count exceeds batchSize", async () => {
    const tempRoot = await makeTempTestDir("screenshot-day-plan-");
    try {
      const sourceDir = `${tempRoot}/Desktop`;
      const destRoot = `${tempRoot}/Daily`;
      await mkdir(sourceDir, { recursive: true });
      await mkdir(destRoot, { recursive: true });

      // 2 files on 2020-11-01 (<= batchSize=3 -> 1 batch for 2020-11-01)
      // 5 files on 2020-11-02 (> batchSize=3 -> 2 sub-batches of [3, 2] for 2020-11-02)
      const filenames = [
        "Screenshot 2020-11-01 at 10.00.01 AM.png",
        "Screenshot 2020-11-01 at 10.00.02 AM.png",
        "Screenshot 2020-11-02 at 10.00.03 AM.png",
        "Screenshot 2020-11-02 at 10.00.04 AM.png",
        "Screenshot 2020-11-02 at 10.00.05 AM.png",
        "Screenshot 2020-11-02 at 10.00.06 AM.png",
        "Screenshot 2020-11-02 at 10.00.07 AM.png",
      ];

      for (const name of filenames) {
        const p = `${sourceDir}/${name}`;
        await writeFile(p, `payload-${name}`, "utf8");
        await setXattr(p, "com.apple.metadata:kMDItemIsScreenCapture");
      }

      // Direct unit check on createArchivePlan:
      // Single day with 2 files and batchSize=50 -> single-day strategy, 1 batch
      const singleDayPlan = createArchivePlan(
        [
          {
            fileDate: "2020-11-01",
            destDir: `${destRoot}/2020/11/01`,
            destDirExistsBefore: false,
          },
          {
            fileDate: "2020-11-01",
            destDir: `${destRoot}/2020/11/01`,
            destDirExistsBefore: false,
          },
        ],
        50,
      );
      expect(singleDayPlan.strategy).toBe("single-day");
      expect(singleDayPlan.dayCount).toBe(1);
      expect(singleDayPlan.batchCount).toBe(1);

      const batchesObserved: BatchProgressEvent[] = [];
      const result = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "archive",
        "2020-11-05",
        {
          batchSize: 3,
          concurrency: 2,
          onBatchComplete: (event) => {
            batchesObserved.push(event);
          },
        },
      );

      expect(result.batchSize).toBe(3);
      expect(result.concurrency).toBe(2);
      expect(result.dayCount).toBe(2);
      expect(result.batchCount).toBe(3);
      expect(result.eligibleCount).toBe(7);
      expect(result.archivedCount).toBe(7);
      expect(batchesObserved.length).toBe(3);
      // Batch 1 is all of 2020-11-01 (2 files); Batches 2 & 3 are 2020-11-02 split into [3, 2]
      expect(
        batchesObserved.map((b) => ({
          date: b.fileDate,
          count: b.files.length,
        })),
      ).toEqual([
        { date: "2020-11-01", count: 2 },
        { date: "2020-11-02", count: 3 },
        { date: "2020-11-02", count: 2 },
      ]);
      expect(result.files.map((f) => f.filename)).toEqual(filenames);

      // Mixed batch test: 1 already-archived file + 2 brand-new files in the same day (2020-11-01)
      const mixedExisting = "Screenshot 2020-11-01 at 10.00.01 AM.png";
      const mixedNew1 = "Screenshot 2020-11-01 at 10.00.08 AM.png";
      const mixedNew2 = "Screenshot 2020-11-01 at 10.00.09 AM.png";
      for (const name of [mixedExisting, mixedNew1, mixedNew2]) {
        const p = `${sourceDir}/${name}`;
        await writeFile(p, `payload-${name}`, "utf8");
        await setXattr(p, "com.apple.metadata:kMDItemIsScreenCapture");
      }

      const mixedResult = await inspectAndProcess(
        {
          sourceDir,
          destRoot,
          dateFormat: "YYYY/MM/DD",
          keepToday: true,
        },
        "archive",
        "2020-11-05",
      );
      expect(mixedResult.dayCount).toBe(1);
      expect(mixedResult.batchCount).toBe(1);
      expect(mixedResult.copiedVerifiedCount).toBe(2);
      expect(mixedResult.deduplicatedCount).toBe(1);
      expect(mixedResult.archivedCount).toBe(3);
      expect(mixedResult.files.map((f) => f.status)).toEqual([
        "archived-deduplicated",
        "archived",
        "archived",
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("audit logging persists archive.log + audit.jsonl, recovers interrupted batch runs, and rotates at threshold", async () => {
    const tempRoot = await makeTempTestDir("screenshot-audit-test-");
    try {
      const sourceDir = `${tempRoot}/Desktop`;
      const destRoot = `${tempRoot}/Daily`;
      const logDir = `${tempRoot}/logs`;
      await mkdir(sourceDir, { recursive: true });
      await mkdir(destRoot, { recursive: true });

      const f1 = "Screenshot 2020-11-01 at 09.00.00 AM.png";
      const f2 = "Screenshot 2020-11-02 at 09.00.00 AM.png";
      await writeFile(`${sourceDir}/${f1}`, "audit-bytes-1", "utf8");
      await writeFile(`${sourceDir}/${f2}`, "audit-bytes-2", "utf8");
      await setXattr(
        `${sourceDir}/${f1}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );
      await setXattr(
        `${sourceDir}/${f2}`,
        "com.apple.metadata:kMDItemIsScreenCapture",
      );

      // Run CLI archive with batch-size 1
      const exitCode = await runCli([
        "archive",
        "--source-dir",
        sourceDir,
        "--dest-root",
        destRoot,
        "--log-dir",
        logDir,
        "--batch-size",
        "1",
        "--concurrency",
        "1",
        "--today",
        "2020-11-05",
        "--no-notify",
      ]);
      expect(exitCode).toBe(0);

      const archiveLog = await readFile(`${logDir}/archive.log`, "utf8");
      expect(archiveLog).toContain("ARCHIVED");
      expect(archiveLog).toContain(
        "Summary: mode=archive scanned=2 matched=2 eligible=2 days=2 batches=2",
      );

      const runs = await readAuditHistory({ logDir });
      expect(runs.length).toBe(1);
      expect(runs[0].archivedCount).toBe(2);
      expect(runs[0].dayCount).toBe(2);
      expect(runs[0].files.length).toBe(2);

      // Simulate an interrupted run where only a batch record was flushed
      await appendBatchAudit(
        {
          runId: "interrupted-run-12345678",
          mode: "archive",
          fileDate: "2020-11-03",
          batchIndex: 1,
          totalBatches: 4,
          timestamp: "2026-11-06T03:15:00.000Z",
          sourceDir,
          destRoot,
          batchCopiedVerifiedCount: 1,
          batchDeduplicatedCount: 0,
          batchArchivedCount: 1,
          batchErrorCount: 0,
          files: [
            {
              filename: "Screenshot 2020-11-03 at 09.00.00 AM.png",
              kind: "screenshot",
              fileDate: "2020-11-03",
              sizeBytes: 42,
              dataless: false,
              hasScreenCaptureXattr: true,
              status: "archived",
              sourcePath: `${sourceDir}/Screenshot 2020-11-03 at 09.00.00 AM.png`,
              destDir: `${destRoot}/2020/11/03`,
              destDirExists: true,
              destPath: `${destRoot}/2020/11/03/Screenshot 2020-11-03 at 09.00.00 AM.png`,
              sourceDeleted: true,
              error: null,
            },
          ],
        },
        { logDir, notifyOnError: false },
      );

      const historyWithInterrupted = await readAuditHistory({ logDir });
      expect(historyWithInterrupted.length).toBe(2);
      expect(historyWithInterrupted[0].runId).toBe("interrupted-run-12345678");
      expect(historyWithInterrupted[0].interrupted).toBe(true);
      expect(historyWithInterrupted[0].dayCount).toBe(1);
      expect(historyWithInterrupted[0].archivedCount).toBe(1);

      const formattedHistory = formatAuditHistory(historyWithInterrupted);
      expect(formattedHistory).toContain("[INTERRUPTED]");

      // Test log rotation keeping max 3 rotated files
      const rotLog = `${logDir}/rot.log`;
      for (let i = 1; i <= 5; i += 1) {
        await writeFile(rotLog, `cycle-${i}-${"x".repeat(200)}`, "utf8");
        if (i < 5) {
          const rotated = await rotateLogIfNeeded(rotLog, 100, 3);
          expect(rotated).toBe(true);
        }
      }
      expect(await fileExists(`${rotLog}.1`)).toBe(true);
      expect(await fileExists(`${rotLog}.2`)).toBe(true);
      expect(await fileExists(`${rotLog}.3`)).toBe(true);
      expect(await fileExists(`${rotLog}.4`)).toBe(false);

      // Invalid --today flag is rejected with exit code 2
      const badTodayCode = await runCli([
        "scan",
        "--source-dir",
        sourceDir,
        "--dest-root",
        destRoot,
        "--today",
        "2026-11-5",
      ]);
      expect(badTodayCode).toBe(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
