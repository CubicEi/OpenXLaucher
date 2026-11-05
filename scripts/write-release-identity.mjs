import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Usage:
 *   node scripts/write-release-identity.mjs <asset-path> [output.json]
 *   node scripts/write-release-identity.mjs <asset-path> --platform macos-aarch64 [output.json]
 *   node scripts/write-release-identity.mjs <asset-path> --platform macos-x86_64 [output.json]
 *
 * asset-path may be a Windows .exe or a macOS .dmg. SHA-256 is computed over the whole file.
 */

const MACOS_PLATFORMS = new Set(["macos-aarch64", "macos-x86_64"]);

function printUsageAndExit() {
  console.error(
    "Usage: node scripts/write-release-identity.mjs <path-to-asset> [--platform macos-aarch64|macos-x86_64] [output.json]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  printUsageAndExit();
}

let assetPath = null;
let platform = null;
let outPathArg = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--platform") {
    platform = args[++i];
    if (!platform || !MACOS_PLATFORMS.has(platform)) {
      console.error(
        `Invalid --platform. Expected one of: ${[...MACOS_PLATFORMS].join(", ")}`,
      );
      process.exit(1);
    }
    continue;
  }
  if (!assetPath) {
    assetPath = arg;
    continue;
  }
  if (!outPathArg) {
    outPathArg = arg;
    continue;
  }
  printUsageAndExit();
}

if (!assetPath) {
  printUsageAndExit();
}

if (!platform) {
  const lower = assetPath.toLowerCase();
  if (lower.includes("macos-aarch64")) platform = "macos-aarch64";
  else if (lower.includes("macos-x86_64") || lower.includes("macos-x64")) {
    platform = "macos-x86_64";
  }
}

const resolvedAsset = path.resolve(assetPath);
if (!fs.existsSync(resolvedAsset)) {
  console.error(`Asset not found: ${resolvedAsset}`);
  process.exit(1);
}

const defaultIdentityName = platform
  ? `OpenXLauncher.identity.${platform}.json`
  : "OpenXLauncher.identity.json";

const outPath =
  outPathArg ??
  path.join(path.dirname(resolvedAsset), defaultIdentityName);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const assetBytes = fs.readFileSync(resolvedAsset);
const sha256 = crypto.createHash("sha256").update(assetBytes).digest("hex");

const uuidPath = path.join("src-tauri", ".build-uuid");
let buildUuid = fs.existsSync(uuidPath)
  ? fs.readFileSync(uuidPath, "utf8").trim()
  : crypto.randomUUID();

if (!buildUuid) {
  buildUuid = crypto.randomUUID();
}

const identity = {
  schema: 1,
  product: "OpenXLauncher",
  version: pkg.version,
  sha256,
  build_uuid: buildUuid,
};

fs.writeFileSync(outPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
console.log(`Wrote ${outPath}`);
