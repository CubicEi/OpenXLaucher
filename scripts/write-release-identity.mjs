import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readBuildUuidFromDmg } from "./lib/macos-build-identity.mjs";

/**
 * Build or merge `OpenXLauncher.identity.json` (schema 2).
 *
 *   node scripts/write-release-identity.mjs --out <path>
 *     [--windows-exe <path>]
 *     [--macos-x86_64-dmg <path>]
 *     [--macos-aarch64-dmg <path>]
 *     [--merge <existing-identity.json>]
 */

const PLATFORM_KEYS = {
  windows: "windows-x86_64",
  macosX64: "macos-x86_64",
  macosArm: "macos-aarch64",
};

function sha256File(filePath) {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readWindowsBuildUuid() {
  const uuidPath = path.join("src-tauri", ".build-uuid");
  if (fs.existsSync(uuidPath)) {
    const value = fs.readFileSync(uuidPath, "utf8").trim();
    if (value) {
      return value;
    }
  }
  return crypto.randomUUID();
}

function platformEntry(platformKey, packageName, assetPath, buildUuid) {
  return {
    package: packageName,
    sha256: sha256File(assetPath),
    build_uuid: buildUuid,
  };
}

function parseArgs(argv) {
  const opts = {
    out: null,
    windowsExe: null,
    macosX64Dmg: null,
    macosAarch64Dmg: null,
    merge: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        opts.out = argv[++i];
        break;
      case "--windows-exe":
        opts.windowsExe = argv[++i];
        break;
      case "--macos-x86_64-dmg":
        opts.macosX64Dmg = argv[++i];
        break;
      case "--macos-aarch64-dmg":
        opts.macosAarch64Dmg = argv[++i];
        break;
      case "--merge":
        opts.merge = argv[++i];
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  if (!opts.out) {
    console.error(
      "Usage: node scripts/write-release-identity.mjs --out <OpenXLauncher.identity.json> [--windows-exe PATH] [--macos-x86_64-dmg PATH] [--macos-aarch64-dmg PATH] [--merge PATH]",
    );
    process.exit(1);
  }

  return opts;
}

function loadMergedPlatforms(mergePath) {
  if (!mergePath) {
    return {};
  }
  const resolved = path.resolve(mergePath);
  if (!fs.existsSync(resolved)) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (raw.schema !== 2 || !raw.platforms) {
    throw new Error(`Merge file must be schema 2: ${resolved}`);
  }
  return { ...raw.platforms };
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const opts = parseArgs(process.argv.slice(2));
const platforms = loadMergedPlatforms(opts.merge);

if (opts.windowsExe) {
  const exe = path.resolve(opts.windowsExe);
  if (!fs.existsSync(exe)) {
    console.error(`Windows exe not found: ${exe}`);
    process.exit(1);
  }
  platforms[PLATFORM_KEYS.windows] = platformEntry(
    PLATFORM_KEYS.windows,
    "OpenXLauncher.exe",
    exe,
    readWindowsBuildUuid(),
  );
}

if (opts.macosX64Dmg) {
  const dmg = path.resolve(opts.macosX64Dmg);
  if (!fs.existsSync(dmg)) {
    console.error(`macOS x64 DMG not found: ${dmg}`);
    process.exit(1);
  }
  platforms[PLATFORM_KEYS.macosX64] = platformEntry(
    PLATFORM_KEYS.macosX64,
    `OpenXLauncher_${pkg.version}_macos-x86_64.dmg`,
    dmg,
    readBuildUuidFromDmg(dmg),
  );
}

if (opts.macosAarch64Dmg) {
  const dmg = path.resolve(opts.macosAarch64Dmg);
  if (!fs.existsSync(dmg)) {
    console.error(`macOS arm64 DMG not found: ${dmg}`);
    process.exit(1);
  }
  platforms[PLATFORM_KEYS.macosArm] = platformEntry(
    PLATFORM_KEYS.macosArm,
    `OpenXLauncher_${pkg.version}_macos-aarch64.dmg`,
    dmg,
    readBuildUuidFromDmg(dmg),
  );
}

if (Object.keys(platforms).length === 0) {
  console.error("No platform credentials produced (pass at least one asset flag).");
  process.exit(1);
}

const identity = {
  schema: 2,
  product: "OpenXLauncher",
  version: pkg.version,
  platforms,
};

const outPath = path.resolve(opts.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
console.log(`Wrote ${outPath}`);
