import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.OPENX_PORTABLE_BUILD = "1";

const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

const result = spawnSync(
  process.execPath,
  [
    tauriCli,
    "build",
    "--config",
    "src-tauri/tauri.portable.conf.json",
  ],
  { cwd: root, stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
