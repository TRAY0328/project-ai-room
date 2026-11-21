/**
 * Design token tests: WCAG AA contrast is a property of the tokens, proven here
 * rather than eyeballed on a screenshot. Also asserts the CSS variable contract
 * that components rely on.
 */
import { describe, expect, it } from "vitest";
import { CONTRAST_REQUIREMENTS, THEMES, checkThemeContrast, contrastRatio, cssVarName, hexToRgb, themeCssVariables } from "@ai-room/design-system/tokens";

describe("design tokens", () => {
  it("meets WCAG AA for every required text/background pair in both themes", () => {
    expect(checkThemeContrast("light")).toEqual([]);
    expect(checkThemeContrast("dark")).toEqual([]);
  });

  it("defines the same keys in light and dark", () => {
    expect(Object.keys(THEMES.light).sort()).toEqual(Object.keys(THEMES.dark).sort());
  });

  it("emits one CSS variable per colour token", () => {
    const vars = themeCssVariables("dark");
    expect(Object.keys(vars)).toHaveLength(Object.keys(THEMES.dark).length);
    expect(vars[cssVarName("text")]).toBe(THEMES.dark.text);
    expect(cssVarName("surface2")).toBe("--air-surface-2");
  });

  it("computes known contrast ratios correctly", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(hexToRgb("#0f8a6a")).toEqual({ r: 15, g: 138, b: 106 });
  });

  it("requires AA (4.5) for body and muted text", () => {
    const required = CONTRAST_REQUIREMENTS.filter((r) => r.fg === "text" || r.fg === "textMuted");
    expect(required.every((r) => r.min === 4.5)).toBe(true);
    for (const req of required) {
      for (const bg of req.bg) {
        expect(contrastRatio(THEMES.dark[req.fg], THEMES.dark[bg])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
