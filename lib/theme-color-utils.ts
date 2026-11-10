/** oklch ↔ hex helpers for the theme color picker UI. */

export function oklchToHex(oklchStr: string): string | null {
  const m = oklchStr.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!m) return null;
  const l = parseFloat(m[1]);
  const c = parseFloat(m[2]);
  const h = parseFloat(m[3]);

  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  const rLinear = +4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const gLinear = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const bLinear = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;

  const toSrgb = (v: number) => {
    const abs = Math.abs(v);
    if (abs <= 0.0031308) return v * 12.92;
    return 1.055 * Math.sign(v) * Math.pow(abs, 1 / 2.4) - 0.055;
  };

  const r = Math.max(0, Math.min(1, toSrgb(rLinear)));
  const g = Math.max(0, Math.min(1, toSrgb(gLinear)));
  const bCh = Math.max(0, Math.min(1, toSrgb(bLinear)));

  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(bCh)}`;
}

export function hexToOklch(hex: string): string | null {
  const m = hex.match(/^#?([\da-f]{6})$/i);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;

  const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const rLin = toLin(r);
  const gLin = toLin(g);
  const bLin = toLin(b);

  const L = 0.4122214708 * rLin + 0.5363325363 * gLin + 0.0514459929 * bLin;
  const M = 0.2119034982 * rLin + 0.6806995451 * gLin + 0.1073969566 * bLin;
  const S = 0.0883024619 * rLin + 0.2817188376 * gLin + 0.6299787005 * bLin;

  const l_ = Math.cbrt(L);
  const m_ = Math.cbrt(M);
  const s_ = Math.cbrt(S);

  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const c = Math.sqrt(a * a + b2 * b2);
  let hDeg = (Math.atan2(b2, a) * 180) / Math.PI;
  if (hDeg < 0) hDeg += 360;
  if (c < 0.0001) hDeg = 0;

  return `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${hDeg.toFixed(2)})`;
}

export function themeColorToHex(themeColor: "default" | string): string {
  if (themeColor === "default") return "#1f1f1f";
  return oklchToHex(themeColor) ?? "#1f1f1f";
}
