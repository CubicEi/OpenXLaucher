import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const exePath = process.argv[2];
if (!exePath) {
  console.error("Usage: node scripts/write-release-identity.mjs <path-to-OpenXLauncher.exe> [output.json]");
  process.exit(1);
}

const outPath =
  process.argv[3] ??
  path.join(path.dirname(path.resolve(exePath)), "OpenXLauncher.identity.json");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const exeBytes = fs.readFileSync(exePath);
const sha256 = crypto.createHash("sha256").update(exeBytes).digest("hex");

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
