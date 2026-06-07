import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Test-only config (kept separate from the Tauri/Vite dev config). Vitest
// transpiles with esbuild, so type-checking of specs is handled by `tsc`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
