/**
 * Monaco bootstrap: one editor instance, token-driven themes, language setup.
 *
 * The workers are loaded through Vite's `?worker` imports. That is the only
 * bundler-specific line in the package and it is isolated here; a different
 * bundler needs its own worker loader, not a different editor.
 */
import * as monaco from "monaco-editor";
import { THEMES, type ThemeName } from "@ai-room/design-system";

let workersReady = false;

/**
 * Language-service workers are intentionally not bundled.
 *
 * Monaco's syntax highlighting (Monarch tokenizers) runs on the main thread, so
 * editing and colours work without workers. What does NOT work — and is stated
 * in the UI — is TypeScript/JSON IntelliSense, diagnostics and the diff worker.
 * Bundling the TypeScript compiler worker alone costs several MB and minutes of
 * build memory in this environment; shipping a fake worker that pretends to
 * type-check would be worse than shipping none.
 */
export function setupMonacoEnvironment(): void {
  if (workersReady) return;
  workersReady = true;
  const noopSource = "self.onmessage = function () { /* language service disabled */ };";
  const env = {
    getWorker(): Worker {
      const blob = new Blob([noopSource], { type: "text/javascript" });
      return new Worker(URL.createObjectURL(blob));
    },
  };
  (self as unknown as { MonacoEnvironment: typeof env }).MonacoEnvironment = env;
}

/** True when the build ships real language workers (currently false). */
export const LANGUAGE_WORKERS_ENABLED = false;

export const EDITOR_THEMES = ["air-light", "air-dark"] as const;

/** Themes derive from the design tokens so the editor never drifts from the app. */
export function defineEditorThemes(): void {
  for (const name of EDITOR_THEMES) {
    const theme: ThemeName = name === "air-dark" ? "dark" : "light";
    const t = THEMES[theme];
    monaco.editor.defineTheme(name, {
      base: theme === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: strip(t.textMuted), fontStyle: "italic" },
        { token: "keyword", foreground: strip(t.accent) },
        { token: "string", foreground: strip(t.ok) },
        { token: "number", foreground: strip(t.info) },
        { token: "type", foreground: strip(t.warn) },
      ],
      colors: {
        "editor.background": t.bg,
        "editor.foreground": t.text,
        "editor.lineHighlightBackground": t.surface,
        "editorLineNumber.foreground": t.textMuted,
        "editorLineNumber.activeForeground": t.text,
        "editor.selectionBackground": t.accentSoft,
        "editorCursor.foreground": t.accent,
        "editorWidget.background": t.surface,
        "editorWidget.border": t.line,
        "diffEditor.insertedTextBackground": t.addBg,
        "diffEditor.removedTextBackground": t.delBg,
        "scrollbarSlider.background": t.lineStrong,
      },
    });
  }
}

function strip(hex: string): string {
  return hex.replace("#", "");
}

export function applyEditorTheme(theme: ThemeName): void {
  monaco.editor.setTheme(theme === "dark" ? "air-dark" : "air-light");
}

/** Languages we advertise in the file tree / language picker (Monaco built-ins). */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  sql: "sql",
  py: "python",
  sh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  rs: "rust",
  go: "go",
  kt: "kotlin",
  java: "java",
  kt2: "kotlin",
  diff: "diff",
};

export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

export { monaco };
