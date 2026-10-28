/**
 * Sync launcher icons from /icon (source of truth) into the web app and Tauri bundle assets.
 *
 * - icon/icon.svg → app/icon.svg, public/icon/icon.svg (favicon / metadata)
 * - icon/icon_black.svg, icon/icon_white.svg → public/icon/ (title bar)
 * - pnpm exec tauri icon … → src-tauri/icons/*.ico, *.png, *.icns (exe / installer / taskbar)
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webOnly = process.argv.includes("--web-only");

const sourceDir = join(root, "icon");
const masterSvg = join(sourceDir, "icon.svg");

if (!existsSync(masterSvg)) {
  console.error("[sync-app-icons] Missing icon/icon.svg");
  process.exit(1);
}

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`[sync-app-icons] ${from.replace(root + "\\", "").replace(root + "/", "")} → ${to.replace(root + "\\", "").replace(root + "/", "")}`);
}

copy(masterSvg, join(root, "app", "icon.svg"));
copy(masterSvg, join(root, "public", "icon", "icon.svg"));

for (const name of ["icon_black.svg", "icon_white.svg"]) {
  const src = join(sourceDir, name);
  if (existsSync(src)) {
    copy(src, join(root, "public", "icon", name));
  }
}

if (webOnly) {
  console.log("[sync-app-icons] Web assets synced (--web-only, skipped tauri icon).");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

const result = spawnSync(
  process.execPath,
  [tauriCli, "icon", "icon/icon.svg", "-o", "src-tauri/icons"],
  { cwd: root, stdio: "inherit", env: process.env },
);

if (result.status !== 0) {
  console.error("[sync-app-icons] tauri icon failed");
  process.exit(result.status ?? 1);
}

console.log("[sync-app-icons] Tauri bundle icons regenerated.");

writeFileSync(
  join(root, "src-tauri", ".icon-sync-stamp"),
  `${Date.now()}\n`,
  "utf8",
);
console.log("[sync-app-icons] Wrote src-tauri/.icon-sync-stamp (forces Cargo to re-embed icon.ico).");
