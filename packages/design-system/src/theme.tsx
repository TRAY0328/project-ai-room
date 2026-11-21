import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BREAKPOINTS, FONT, MOTION, RADIUS, SPACE, THEMES, themeCssVariables, type ThemeName } from "./tokens.js";

export type ThemePreference = ThemeName | "system";

interface ThemeContextValue {
  theme: ThemeName;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ThemeName {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredPreference(): ThemePreference {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("air.theme") : null;
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* storage blocked: fall through to system preference, never throw in render */
  }
  return "system";
}

/** Applies every colour token of the active theme to <html> as --air-*. */
export function applyThemeVariables(theme: ThemeName, root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null): void {
  if (!root) return;
  root.setAttribute("data-theme", theme);
  const vars = themeCssVariables(theme);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  const neutral = THEMES[theme];
  root.style.setProperty("background-color", neutral.bg);
  root.style.setProperty("color-scheme", theme);
  root.style.setProperty("--air-font-sans", FONT.sans);
  root.style.setProperty("--air-font-mono", FONT.mono);
  root.style.setProperty("--air-ease", MOTION.easing);
  for (const [key, px] of Object.entries(SPACE)) root.style.setProperty(`--air-space-${key}`, `${px}px`);
  for (const [key, px] of Object.entries(RADIUS)) root.style.setProperty(`--air-radius-${key}`, `${px}px`);
  for (const [key, px] of Object.entries(BREAKPOINTS)) root.style.setProperty(`--air-bp-${key}`, `${px}px`);
}

export function ThemeProvider({ children, initialPreference }: { children: ReactNode; initialPreference?: ThemePreference }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => initialPreference ?? readStoredPreference());
  const [system, setSystem] = useState<ThemeName>(() => systemTheme());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mql.matches ? "dark" : "light");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const theme: ThemeName = preference === "system" ? system : preference;

  useEffect(() => {
    applyThemeVariables(theme);
    try {
      localStorage.setItem("air.theme", preference);
    } catch {
      /* ignore storage failures */
    }
  }, [theme, preference]);

  const setPreference = useCallback((p: ThemePreference) => setPreferenceState(p), []);
  const toggle = useCallback(() => setPreferenceState((prev) => {
    const current: ThemeName = prev === "system" ? systemTheme() : prev;
    return current === "dark" ? "light" : "dark";
  }), []);

  const value = useMemo<ThemeContextValue>(() => ({ theme, preference, setPreference, toggle }), [theme, preference, setPreference, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

/** Honours prefers-reduced-motion without shipping a second animation path. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Responsive helper: which breakpoint is currently active. */
export function useBreakpoint(): keyof typeof BREAKPOINTS | "xs" {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);
  if (width >= BREAKPOINTS.xxl) return "xxl";
  if (width >= BREAKPOINTS.xl) return "xl";
  if (width >= BREAKPOINTS.lg) return "lg";
  if (width >= BREAKPOINTS.md) return "md";
  if (width >= BREAKPOINTS.sm) return "sm";
  return "xs";
}
