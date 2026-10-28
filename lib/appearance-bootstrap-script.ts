/**
 * Synchronous pre-paint bootstrap (inlined into <head>).
 * Keep logic aligned with lib/appearance-palette.ts.
 */
export const APPEARANCE_BOOTSTRAP_SCRIPT = `(function(){
  try {
    var KEY = "openxlauncher:settings:v4";
    var LEGACY = ["openxlauncher:settings:v3","rtlauncher:settings:v4","rtlauncher:settings:v3"];
    var raw = localStorage.getItem(KEY);
    if (!raw) {
      for (var i = 0; i < LEGACY.length; i++) {
        raw = localStorage.getItem(LEGACY[i]);
        if (raw) break;
      }
    }
    var appearance = {};
    var lang = null;
    var themeId = "builtin.default";
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        appearance = (parsed && parsed.appearance) || {};
        lang = parsed && parsed.general && parsed.general.language;
        if (appearance.themeId) themeId = appearance.themeId;
      } catch (e) {}
    }
    var mode = appearance.themeMode || "system";
    var themeColor = appearance.themeColor || "default";
    var fontSize = appearance.fontSize;
    var isDark = mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.classList.toggle("dark", isDark);
    root.style.colorScheme = isDark ? "dark" : "light";
    if (lang) root.lang = lang;
    root.setAttribute("data-openx-theme", themeId);

    function makeOklch(l,c,h){return "oklch("+l.toFixed(3)+" "+c.toFixed(3)+" "+h.toFixed(3)+")";}
    function parseOklch(v){
      var m = String(v).match(/oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/);
      return m ? {l:+m[1],c:+m[2],h:+m[3]} : null;
    }
    var LIGHT = {
      background:"oklch(1 0 0)",foreground:"oklch(0.147 0.004 49.25)",card:"oklch(1 0 0)",cardForeground:"oklch(0.147 0.004 49.25)",
      popover:"oklch(1 0 0)",popoverForeground:"oklch(0.147 0.004 49.25)",primary:"oklch(0.216 0.006 56.043)",primaryForeground:"oklch(0.985 0.001 106.423)",
      secondary:"oklch(0.97 0.001 106.424)",secondaryForeground:"oklch(0.216 0.006 56.043)",muted:"oklch(0.97 0.001 106.424)",mutedForeground:"oklch(0.553 0.013 58.071)",
      accent:"oklch(0.97 0.001 106.424)",accentForeground:"oklch(0.216 0.006 56.043)",border:"oklch(0.923 0.003 48.717)",input:"oklch(0.923 0.003 48.717)",ring:"oklch(0.709 0.01 56.259)"
    };
    var DARK = {
      background:"oklch(0.147 0.004 49.25)",foreground:"oklch(0.985 0.001 106.423)",card:"oklch(0.216 0.006 56.043)",cardForeground:"oklch(0.985 0.001 106.423)",
      popover:"oklch(0.216 0.006 56.043)",popoverForeground:"oklch(0.985 0.001 106.423)",primary:"oklch(0.923 0.003 48.717)",primaryForeground:"oklch(0.216 0.006 56.043)",
      secondary:"oklch(0.268 0.007 34.298)",secondaryForeground:"oklch(0.985 0.001 106.423)",muted:"oklch(0.268 0.007 34.298)",mutedForeground:"oklch(0.709 0.01 56.259)",
      accent:"oklch(0.268 0.007 34.298)",accentForeground:"oklch(0.985 0.001 106.423)",border:"oklch(0.294 0.005 56.043)",input:"oklch(0.334 0.005 56.043)",ring:"oklch(0.553 0.013 58.071)"
    };
    function derive(primaryOklch, dark){
      var p = parseOklch(primaryOklch);
      if (!p) return dark ? DARK : LIGHT;
      var l=p.l,c=p.c,h=p.h;
      if (!dark) {
        var bc=Math.min(0.008,c*0.04), cc=Math.min(0.005,c*0.025), sc=Math.min(0.012,c*0.06), brc=Math.min(0.02,c*0.1), fc=Math.min(0.01,c*0.05), mc=Math.min(0.018,c*0.09), ac=Math.min(0.05,c*0.22);
        return {background:makeOklch(0.995,bc,h),foreground:makeOklch(0.15,fc,h),card:makeOklch(0.995,cc,h),cardForeground:makeOklch(0.15,fc,h),popover:makeOklch(0.995,cc,h),popoverForeground:makeOklch(0.15,fc,h),primary:primaryOklch,primaryForeground:l<0.55?makeOklch(0.99,0.005,h):makeOklch(0.15,fc,h),secondary:makeOklch(0.96,sc,h),secondaryForeground:makeOklch(0.25,Math.min(0.1,c*0.45),h),muted:makeOklch(0.955,sc,h),mutedForeground:makeOklch(0.5,mc,h),accent:makeOklch(0.95,ac,h),accentForeground:makeOklch(0.25,Math.min(0.12,c*0.5),h),border:makeOklch(0.91,brc,h),input:makeOklch(0.91,brc,h),ring:makeOklch(l+0.1,c,h)};
      }
      var cardC=Math.min(0.04,c*0.2);
      return {background:makeOklch(0.15,Math.min(0.03,c*0.15),h),foreground:makeOklch(0.98,0.005,h),card:makeOklch(0.22,cardC,h),cardForeground:makeOklch(0.98,0.005,h),popover:makeOklch(0.22,cardC,h),popoverForeground:makeOklch(0.98,0.005,h),primary:makeOklch(Math.min(0.92,l+0.2),c,h),primaryForeground:makeOklch(0.22,cardC,h),secondary:makeOklch(0.28,Math.min(0.05,c*0.25),h),secondaryForeground:makeOklch(0.92,c*0.2,h),muted:makeOklch(0.3,Math.min(0.04,c*0.2),h),mutedForeground:makeOklch(0.75,Math.min(0.08,c*0.4),h),accent:makeOklch(0.26,Math.min(0.05,c*0.25),h),accentForeground:makeOklch(0.9,Math.min(0.08,c*0.4),h),border:makeOklch(0.314,cardC*0.88,h),input:makeOklch(0.36,cardC*0.82,h),ring:makeOklch(Math.min(0.78,l+0.15),c,h)};
    }
    var colors = themeColor === "default" ? (isDark ? DARK : LIGHT) : derive(themeColor, isDark);
    var map = [["--background",colors.background],["--foreground",colors.foreground],["--card",colors.card],["--card-foreground",colors.cardForeground],["--popover",colors.popover],["--popover-foreground",colors.popoverForeground],["--primary",colors.primary],["--primary-foreground",colors.primaryForeground],["--secondary",colors.secondary],["--secondary-foreground",colors.secondaryForeground],["--muted",colors.muted],["--muted-foreground",colors.mutedForeground],["--accent",colors.accent],["--accent-foreground",colors.accentForeground],["--border",colors.border],["--input",colors.input],["--ring",colors.ring],["--sidebar",colors.card],["--sidebar-foreground",colors.foreground],["--sidebar-primary",colors.primary],["--sidebar-primary-foreground",colors.primaryForeground],["--sidebar-accent",colors.muted],["--sidebar-accent-foreground",colors.foreground],["--sidebar-border",colors.border],["--sidebar-ring",colors.ring]];
    for (var j=0;j<map.length;j++) root.style.setProperty(map[j][0], map[j][1]);
    if (typeof fontSize === "number" && isFinite(fontSize)) {
      var fs = Math.max(1, Math.min(30, Math.round(fontSize)));
      root.style.setProperty("--app-font-size", fs + "px");
      root.style.setProperty("--app-font-scale", (fs / 14).toFixed(3));
    }
    root.setAttribute("data-session-theme-color", themeColor === "default" ? "default" : themeColor);
    root.setAttribute("data-theme-ready", "");
  } catch (err) {}
})();`;
