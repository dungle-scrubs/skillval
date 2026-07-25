import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the report app as one IIFE bundle plus one stylesheet, which the CLI inlines into each
// self-contained report file (see scripts/embed-report-ui.mjs and src/report-shell.ts).
export default defineConfig({
  // Lib mode leaves process.env.NODE_ENV for the consumer to define; this bundle runs directly in
  // a browser, so it must be resolved at build time or React crashes on a bare `process`.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    cssCodeSplit: false,
    lib: {
      entry: "index.tsx",
      fileName: () => "report-app.js",
      formats: ["iife"],
      name: "SkillvalReport",
    },
    outDir: "dist",
    rollupOptions: { output: { assetFileNames: "report-app.[ext]" } },
  },
  plugins: [react(), tailwindcss()],
  root: import.meta.dirname,
});
