import {
  APPEARANCE_BACKGROUND_DB_NAME,
  APPEARANCE_BACKGROUND_DB_VERSION,
  APPEARANCE_BACKGROUND_IMAGE_KEY,
  APPEARANCE_BACKGROUND_STORE,
} from "@/lib/appearance-background-idb";

const SETTINGS_STORAGE_KEY = "openxlauncher:settings:v4";

/**
 * 尽早从 IndexedDB 恢复背景：用 blob: URL。
 * 同步 bootstrapDataUrl 只负责首帧；此处在未锁定前升级为原图 blob，减少色差。
 */
export const APPEARANCE_BACKGROUND_BOOTSTRAP_SCRIPT = `(function(){
  try {
    var KEY = ${JSON.stringify(SETTINGS_STORAGE_KEY)};
    var raw = localStorage.getItem(KEY);
    if (!raw) return;
    var parsed = JSON.parse(raw);
    var pageBg = parsed && parsed.appearance && parsed.appearance.background;
    if (!pageBg || !pageBg.hasStoredImage) return;
    var root = document.documentElement;
    function markActive(){
      root.setAttribute("data-app-bg", "active");
      root.setAttribute("data-session-background", "active");
      if (document.body) document.body.setAttribute("data-app-bg", "active");
    }
    function applyBg(objectUrl, force){
      if (root.getAttribute("data-session-background-locked") !== null) return;
      var painted = (root.style.getPropertyValue("--app-bg") || "").trim();
      if (!force && painted && painted !== "none") return;
      // 先解码再替换，避免预览 → 原图切换时出现空白帧
      var img = new Image();
      img.onload = function(){
        if (root.getAttribute("data-session-background-locked") !== null) return;
        root.style.setProperty("--app-bg", "url(" + JSON.stringify(objectUrl) + ")");
        var bgOp = typeof pageBg.opacity === "number" ? pageBg.opacity : 0.55;
        var bgBlur = typeof pageBg.blur === "number" ? pageBg.blur : 6;
        root.style.setProperty("--app-bg-opacity", Number(bgOp).toFixed(2));
        root.style.setProperty("--app-bg-blur", Math.round(bgBlur) + "px");
        markActive();
      };
      img.src = objectUrl;
    }
    var existing = (root.style.getPropertyValue("--app-bg") || "").trim();
    var hasSyncFrame = !!(existing && existing !== "none");
    if (hasSyncFrame) markActive();

    if (pageBg.imageDataUrl && String(pageBg.imageDataUrl).length > 0 && !hasSyncFrame) {
      var legacy = String(pageBg.imageDataUrl);
      fetch(legacy).then(function(r){ return r.blob(); }).then(function(blob){
        if (blob && blob.size) applyBg(URL.createObjectURL(blob), false);
      }).catch(function(){});
      return;
    }

    var DB_NAME = ${JSON.stringify(APPEARANCE_BACKGROUND_DB_NAME)};
    var DB_VER = ${APPEARANCE_BACKGROUND_DB_VERSION};
    var STORE = ${JSON.stringify(APPEARANCE_BACKGROUND_STORE)};
    var IMG_KEY = ${JSON.stringify(APPEARANCE_BACKGROUND_IMAGE_KEY)};
    var req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function(e){
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = function(){
      var db = req.result;
      var tx = db.transaction(STORE, "readonly");
      var get = tx.objectStore(STORE).get(IMG_KEY);
      get.onsuccess = function(){
        var value = get.result;
        if (value instanceof Blob && value.size > 0) {
          applyBg(URL.createObjectURL(value), hasSyncFrame);
          return;
        }
        if (typeof value === "string" && value.length > 0) {
          fetch(String(value)).then(function(r){ return r.blob(); }).then(function(blob){
            if (blob && blob.size) applyBg(URL.createObjectURL(blob), hasSyncFrame);
          }).catch(function(){});
        }
      };
    };
  } catch (err) {}
})();`;
