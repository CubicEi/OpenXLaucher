/**
 * Rebuild schematic-viewer assets from misode/mcmeta + deepslate UMD.
 * Usage: node scripts/build-schematic-assets.mjs [mcmetaVersion]
 * Default mcmetaVersion: 26.3
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "public", "schematic-viewer");
const tmpDir = path.join(root, "tmp-deepslate-upgrade");

const MCMETA_VERSION = process.argv[2] || "26.3";
const DEEPSLATE_VERSION = process.argv[3] || "0.27.2";

const MCMETA = "https://raw.githubusercontent.com/misode/mcmeta";
const NPM = `https://cdn.jsdelivr.net/npm/deepslate@${DEEPSLATE_VERSION}`;

async function download(url, dest) {
  console.log("GET", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log("  ->", dest, `(${buf.length} bytes)`);
  return buf;
}

async function downloadJson(url) {
  console.log("GET", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function writeAssetsJs(assets, dest) {
  const json = JSON.stringify(assets);
  // Single-quoted JS string: escape \ and '
  const escaped = json.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  fs.writeFileSync(dest, `const assets = JSON.parse('${escaped}')\n`);
  console.log("Wrote", dest, `(${fs.statSync(dest).size} bytes)`);
}

async function main() {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const [blockstates, models, textures] = await Promise.all([
    downloadJson(`${MCMETA}/${MCMETA_VERSION}-summary/assets/block_definition/data.min.json`),
    downloadJson(`${MCMETA}/${MCMETA_VERSION}-summary/assets/model/data.min.json`),
    downloadJson(`${MCMETA}/${MCMETA_VERSION}-atlas/all/data.min.json`),
  ]);

  await download(
    `${MCMETA}/${MCMETA_VERSION}-atlas/all/atlas.png`,
    path.join(outDir, "atlas.png"),
  );

  writeAssetsJs({ blockstates, models, textures }, path.join(outDir, "assets.js"));

  const umdPath = path.join(tmpDir, "deepslate.umd.cjs");
  await download(`${NPM}/dist/deepslate.umd.cjs`, umdPath);
  fs.copyFileSync(umdPath, path.join(outDir, "deepslate.js"));
  console.log("Copied deepslate.js");

  const meta = {
    deepslate: DEEPSLATE_VERSION,
    mcmeta: MCMETA_VERSION,
    builtAt: new Date().toISOString(),
    blockstates: Object.keys(blockstates).length,
    models: Object.keys(models).length,
    textures: Object.keys(textures).length,
  };
  fs.writeFileSync(path.join(outDir, "ASSETS_VERSION.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log("Done:", meta);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
