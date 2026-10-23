import { spawnSync } from "node:child_process";

process.env.OPENX_PORTABLE_BUILD = "1";

const result = spawnSync(
  "pnpm",
  ["exec", "tauri", "build", "--config", "src-tauri/tauri.portable.conf.json"],
  { stdio: "inherit", shell: true, env: process.env },
);

process.exit(result.status ?? 1);
