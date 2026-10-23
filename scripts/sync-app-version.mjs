/**
 * Verifies launcher version is only defined in root package.json.
 * (Tauri: ../package.json path; Rust: build.rs → LAUNCHER_VERSION)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

if (!version || typeof version !== "string") {
  console.error("[verify-app-version] package.json is missing a string \"version\" field.");
  process.exit(1);
}

let failed = false;

const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
if (tauriConf.version !== "../package.json") {
  console.error(
    `[verify-app-version] tauri.conf.json version must be "../package.json", got ${JSON.stringify(tauriConf.version)}`,
  );
  failed = true;
}

const buildOverride = JSON.parse(
  readFileSync(join(root, "src-tauri/tauri.build-override.json"), "utf8"),
);
if ("version" in buildOverride) {
  console.error(
    "[verify-app-version] tauri.build-override.json must not define \"version\" (use tauri.conf.json → ../package.json).",
  );
  failed = true;
}

const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
const cargoMatch = cargo.match(/^version\s*=\s*"([^"]*)"/m);
if (!cargoMatch || cargoMatch[1] !== "0.0.0") {
  console.error(
    '[verify-app-version] Cargo.toml [package].version must stay placeholder "0.0.0" (real version from package.json via build.rs).',
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`[verify-app-version] OK — app version ${version} (package.json only)`);
