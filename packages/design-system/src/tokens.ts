/**
 * Design tokens (spec 17.1)
 *
 * One source of truth for colour, spacing, type, motion and breakpoints.
 * The runtime theme provider writes the colour tokens into CSS custom
 * properties, so the CSS and the TypeScript stay in sync — there is no second
 * hand-maintained palette to drift.
 *
 * Rules encoded here:
 *  - body text and muted text must reach WCAG AA (4.5:1) on their surfaces;
 *    `checkThemeContrast()` proves it at test time, not by eye.
 *  - status is never colour-only: every status renders a word plus a shape.
 *  - motion is 150–300ms and is disabled under `prefers-reduced-motion`.
 */

export type ThemeName = "light" | "dark";

export interface ThemeColors {
  /** page background */
  bg: string;
  /** raised surface (panels, cards) */
  surface: string;
  /** sunken surface (sidebars, code gutters) */
  surface2: string;
  /** hairline borders */
  line: string;
  /** strong border (focus-visible ring uses accent, not this) */
  lineStrong: string;
  /** primary text */
  text: string;
  /** secondary text — must still be AA */
  textMuted: string;
  /** disabled text — exempt from AA, never used for meaning */
  textDisabled: string;
  /** brand accent */
  accent: string;
  accentHover: string;
  /** text/icon placed on accent */
  onAccent: string;
  /** soft accent wash for selected rows */
  accentSoft: string;
  ok: string;
  warn: string;
  danger: string;
  info: string;
  /** code/monospace block background */
  codeBg: string;
  /** diff additions / deletions (wash + ink) */
  addBg: string;
  addInk: string;
  delBg: string;
  delInk: string;
  /** modal scrim */
  scrim: string;
  /** elevation shadow colour */
  shadow: string;
}

export const THEMES: Readonly<Record<ThemeName, ThemeColors>> = Object.freeze({
  light: {
    bg: "#ffffff",
    surface: "#f7f7f8",
    surface2: "#efeff1",
    line: "#e3e3e6",
    lineStrong: "#c9c9ce",
    text: "#0d0d0d",
    textMuted: "#59595f",
    textDisabled: "#8e8e94",
    accent: "#0d7f62",
    accentHover: "#096b52",
    onAccent: "#ffffff",
    accentSoft: "#e6f5f0",
    ok: "#067647",
    warn: "#8a4b00",
    danger: "#a3231a",
    info: "#175cd3",
    codeBg: "#f4f4f5",
    addBg: "#e8f7ee",
    addInk: "#04543a",
    delBg: "#fdeceb",
    delInk: "#8c1d15",
    scrim: "rgba(13, 13, 13, 0.45)",
    shadow: "rgba(13, 13, 13, 0.10)",
  },
  dark: {
    bg: "#141414",
    surface: "#1c1c1e",
    surface2: "#232326",
    line: "#333338",
    lineStrong: "#4a4a51",
    text: "#ececef",
    textMuted: "#a6a6ad",
    textDisabled: "#74747b",
    accent: "#2fbf95",
    accentHover: "#48d2a8",
    onAccent: "#04140f",
    accentSoft: "#13322a",
    ok: "#5ed49b",
    warn: "#f0b357",
    danger: "#ff8a80",
    info: "#8ab4ff",
    codeBg: "#1a1a1c",
    addBg: "#10281e",
    addInk: "#9be8bf",
    delBg: "#2b1616",
    delInk: "#ffb3ac",
    scrim: "rgba(0, 0, 0, 0.6)",
    shadow: "rgba(0, 0, 0, 0.45)",
  },
});

/** Token key -> CSS custom property name. */
export function cssVarName(key: keyof ThemeColors): string {
  return `--air-${key.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`).replace(/(\d+)/g, "-$1")}`;
}

/** Flattened `--air-*` map for a theme; applied to <html> by ThemeProvider. */
export function themeCssVariables(theme: ThemeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(THEMES[theme])) {
    out[cssVarName(key as keyof ThemeColors)] = value;
  }
  return out;
}

export const SPACE = Object.freeze([0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
export const RADIUS = Object.freeze({ sm: 6, md: 10, lg: 14, xl: 20, pill: 999 });
export const FONT = Object.freeze({
  sans: `ui-sans-serif, -apple-system, "Segoe UI Variable", "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif`,
  mono: `"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, "D2Coding", monospace`,
  size: Object.freeze({ xs: 11, sm: 12, md: 13, base: 14, lg: 16, xl: 20, xxl: 26 }),
  line: Object.freeze({ tight: 1.25, base: 1.5, loose: 1.65 }),
});

/** Mobile-first breakpoints (px). Layouts never assume one fixed resolution. */
export const BREAKPOINTS = Object.freeze({ sm: 480, md: 768, lg: 1024, xl: 1280, xxl: 1560 });

export type BreakpointName = keyof typeof BREAKPOINTS;

export const MOTION = Object.freeze({ fast: 150, base: 200, slow: 300, easing: "cubic-bezier(0.2, 0, 0.2, 1)" });

export const Z_INDEX = Object.freeze({ sticky: 10, drawer: 40, dialog: 50, toast: 60 });

/* ------------------------------------------------------------------ */
/* Contrast (WCAG 2.1 relative luminance)                              */
/* ------------------------------------------------------------------ */

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ContrastRequirement {
  readonly fg: keyof ThemeColors;
  readonly bg: Array<keyof ThemeColors>;
  readonly min: number;
  readonly why: string;
}

/** Pairs the design system promises to keep legible. Used by tokens.test.mjs. */
export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = Object.freeze([
  { fg: "text", bg: ["bg", "surface", "surface2"], min: 4.5, why: "body text AA" },
  { fg: "textMuted", bg: ["bg", "surface", "surface2"], min: 4.5, why: "secondary text AA" },
  { fg: "onAccent", bg: ["accent", "accentHover"], min: 4.5, why: "button label on accent" },
  { fg: "ok", bg: ["bg", "surface"], min: 4.5, why: "status word, light bg" },
  { fg: "warn", bg: ["bg", "surface"], min: 4.5, why: "status word" },
  { fg: "danger", bg: ["bg", "surface"], min: 4.5, why: "status word" },
  { fg: "info", bg: ["bg", "surface"], min: 4.5, why: "status word" },
  { fg: "addInk", bg: ["addBg"], min: 4.5, why: "diff addition line" },
  { fg: "delInk", bg: ["delBg"], min: 4.5, why: "diff deletion line" },
]);

export interface ContrastFailure {
  theme: ThemeName;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  why: string;
}

export function checkThemeContrast(theme: ThemeName): ContrastFailure[] {
  const palette = THEMES[theme];
  const failures: ContrastFailure[] = [];
  for (const req of CONTRAST_REQUIREMENTS) {
    for (const bgKey of req.bg) {
      const ratio = contrastRatio(palette[req.fg], palette[bgKey]);
      if (ratio + 1e-9 < req.min) {
        failures.push({ theme, fg: req.fg, bg: bgKey, ratio, min: req.min, why: req.why });
      }
    }
  }
  return failures;
}
