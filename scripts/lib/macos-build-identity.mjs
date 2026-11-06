import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Must match `identity::MACOS_BUNDLE_BUILD_IDENTITY_FILE` and Tauri bundle resource name. */
export const MACOS_BUILD_IDENTITY_FILE = "macos-build-identity.uuid";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMacosBuildUuid(text) {
  const trimmed = String(text).trim();
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`Invalid build UUID in ${MACOS_BUILD_IDENTITY_FILE}`);
  }
  return trimmed.toLowerCase();
}

function findFileByName(rootDir, fileName) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileByName(full, fileName);
      if (nested) {
        return nested;
      }
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return null;
}

function readUuidFromPath(uuidPath) {
  if (!uuidPath || !fs.existsSync(uuidPath)) {
    throw new Error(`${MACOS_BUILD_IDENTITY_FILE} not found under DMG contents`);
  }
  return parseMacosBuildUuid(fs.readFileSync(uuidPath, "utf8"));
}

function readBuildUuidFromDmgDarwin(dmgPath) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "openx-dmg-"));
  try {
    execFileSync(
      "hdiutil",
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath],
      { stdio: "pipe" },
    );
    const uuidPath = findFileByName(mountPoint, MACOS_BUILD_IDENTITY_FILE);
    return readUuidFromPath(uuidPath);
  } finally {
    try {
      execFileSync("hdiutil", ["detach", mountPoint, "-force"], {
        stdio: "ignore",
      });
    } catch {
      // ignore detach errors during cleanup
    }
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function resolve7zExecutable() {
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const candidates = [
      path.join(programFiles, "7-Zip", "7z.exe"),
      path.join(programFilesX86, "7-Zip", "7z.exe"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
  return "7z";
}

function readBuildUuidFromDmg7z(dmgPath) {
  const sevenZip = resolve7zExecutable();
  if (!sevenZip || (process.platform === "win32" && !fs.existsSync(sevenZip))) {
    throw new Error(
      "Reading build UUID from DMG on Windows requires 7-Zip (7z.exe). Install 7-Zip or run write-release-identity on macOS.",
    );
  }
  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openx-dmg-7z-"));
  try {
    execFileSync(sevenZip, ["x", dmgPath, `-o${extractRoot}`, "-y"], {
      stdio: "pipe",
    });
    const uuidPath = findFileByName(extractRoot, MACOS_BUILD_IDENTITY_FILE);
    return readUuidFromPath(uuidPath);
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
}

/** Read `macos-build-identity.uuid` from a release DMG (macOS: hdiutil, Windows: 7-Zip). */
export function readBuildUuidFromDmg(dmgPath) {
  const resolved = path.resolve(dmgPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`DMG not found: ${resolved}`);
  }
  if (process.platform === "darwin") {
    return readBuildUuidFromDmgDarwin(resolved);
  }
  return readBuildUuidFromDmg7z(resolved);
}
