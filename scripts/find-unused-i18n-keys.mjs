import fs from "fs";
import path from "path";

function flatten(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flatten(v, key));
    } else {
      keys.push(key);
    }
  }
  return keys;
}

function walk(dir, exts, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "target", "dist", ".git", "scripts"].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, exts, files);
    else if (exts.some((e) => ent.name.endsWith(e))) files.push(p);
  }
  return files;
}

function unflattenDelete(obj, keyPath) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== "object") return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === "object") {
    delete cur[parts[parts.length - 1]];
  }
}

function pruneEmptyObjects(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const key of Object.keys(obj)) {
    pruneEmptyObjects(obj[key]);
    if (
      obj[key] &&
      typeof obj[key] === "object" &&
      !Array.isArray(obj[key]) &&
      Object.keys(obj[key]).length === 0
    ) {
      delete obj[key];
    }
  }
}

const root = process.cwd();
const enPath = path.join(root, "components/i18n/locales/en-US.json");
const zhPath = path.join(root, "components/i18n/locales/zh-CN.json");
const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
const allKeys = flatten(en);

const srcFiles = walk(root, [".ts", ".tsx", ".json", ".rs"]).filter(
  (f) => !f.includes(`${path.sep}locales${path.sep}`) && !f.endsWith("en-US.json"),
);

let corpus = "";
for (const file of srcFiles) {
  corpus += fs.readFileSync(file, "utf8") + "\n";
}

/** Keys referenced as string literals in code or constants */
const used = new Set();
for (const k of allKeys) {
  if (corpus.includes(`"${k}"`) || corpus.includes(`'${k}'`) || corpus.includes(`\`${k}\``)) {
    used.add(k);
  }
}

/**
 * Keys used only via dynamic prefix (e.g. t(\`download.detail.projectType.${x}\`))
 * Keep whole group if any sibling is used and pattern exists
 */
const dynamicPrefixRe = /[`'"]([a-zA-Z][\w.]*)\$\{/g;
let dm;
while ((dm = dynamicPrefixRe.exec(corpus))) {
  const prefix = dm[1].replace(/\.$/, "");
  for (const k of allKeys) {
    if (k.startsWith(prefix)) used.add(k);
  }
}

const unused = allKeys.filter((k) => !used.has(k)).sort();

console.log(
  JSON.stringify(
    { total: allKeys.length, used: used.size, unused: unused.length, keys: unused },
    null,
    2,
  ),
);

if (process.argv.includes("--apply") && unused.length > 0) {
  const enCopy = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const zhCopy = JSON.parse(fs.readFileSync(zhPath, "utf8"));
  for (const k of unused) {
    unflattenDelete(enCopy, k);
    unflattenDelete(zhCopy, k);
  }
  pruneEmptyObjects(enCopy);
  pruneEmptyObjects(zhCopy);
  fs.writeFileSync(enPath, `${JSON.stringify(enCopy, null, 2)}\n`, "utf8");
  fs.writeFileSync(zhPath, `${JSON.stringify(zhCopy, null, 2)}\n`, "utf8");
  console.error(`Removed ${unused.length} unused keys from en-US.json and zh-CN.json`);
}
