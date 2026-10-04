// Compiles .design-sync/tailwind.css (via css-entry.ts) for design-sync only.
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, ".."),
  publicDir: false,
  plugins: [tailwindcss()],
  build: {
    outDir: resolve(__dirname, "../dist/ds/vite"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: { input: resolve(__dirname, "css-entry.ts") },
  },
});
