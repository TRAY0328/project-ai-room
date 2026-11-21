import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
// Path resolution without Node types: import.meta.url is a URL, and Vite runs this
// config in Node. A leading slash is dropped for Windows drive paths.
const resolvePath = (p: string): string => {
  const pathname = new URL(p, import.meta.url).pathname;
  const decoded = decodeURIComponent(pathname);
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // exact subpath first: the generic package alias would otherwise swallow it
      { find: /^@ai-room\/design-system\/base\.css$/, replacement: resolvePath("../../packages/design-system/src/base.css") },
      { find: /^@ai-room\/message-blocks\/react$/, replacement: resolvePath("../../packages/message-blocks/src/react.tsx") },
      { find: /^@ai-room\/design-system\/tokens$/, replacement: resolvePath("../../packages/design-system/src/tokens.ts") },
      { find: /^@ai-room\/design-system$/, replacement: resolvePath("../../packages/design-system/src/index.ts") },
      { find: /^@ai-room\/message-blocks$/, replacement: resolvePath("../../packages/message-blocks/src/index.ts") },
      { find: /^@ai-room\/editor\/diff$/, replacement: resolvePath("../../packages/editor/src/DiffViewer.tsx") },
      { find: /^@ai-room\/editor\/review$/, replacement: resolvePath("../../packages/editor/src/ReviewPanel.tsx") },
      { find: /^@ai-room\/editor\/ci$/, replacement: resolvePath("../../packages/editor/src/CIPanel.tsx") },
      { find: /^@ai-room\/editor\/terminal$/, replacement: resolvePath("../../packages/editor/src/TerminalPanel.tsx") },
      { find: /^@ai-room\/editor\/tree$/, replacement: resolvePath("../../packages/editor/src/FileTree.tsx") },
      { find: /^@ai-room\/editor$/, replacement: resolvePath("../../packages/editor/src/index.ts") },
    ],
  },
  // Monaco ships ESM workers; the classic (iife) worker format cannot parse them.
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    fs: { allow: [resolvePath("../..")] },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("monaco-editor")) return "monaco";
          if (id.includes("node_modules/yjs") || id.includes("y-monaco") || id.includes("y-protocols") || id.includes("lib0")) return "collab";
          if (id.includes("node_modules/react")) return "react";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    // this sandbox has no /etc/hosts entry for localhost; 127.0.0.1 needs no DNS
    environmentOptions: { jsdom: { url: "http://127.0.0.1:5173/" } },
    server: { deps: { inline: ["@ai-room/design-system"] } },
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
