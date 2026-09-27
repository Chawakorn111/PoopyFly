import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The processed MaleCNS runtime graphs live in public/data and are served as-is.
// They are large (up to ~600 MB for FULL), so we disable asset inlining and let
// the dev server stream them. For production builds, serve public/data from a
// static host rather than bundling.
export default defineConfig({
  plugins: [react()],
  // The processed MaleCNS graphs are served straight from public/data at runtime.
  // Set FLYBRAIN_SKIP_PUBLIC=1 to bundle without copying ~1.5 GB of data (CI/type
  // checks); the dev server always serves the real files.
  publicDir: process.env.FLYBRAIN_SKIP_PUBLIC ? false : "public",
  build: {
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
  },
  worker: {
    format: "es",
  },
  server: {
    watch: { ignored: ["**/public/data/**"] },
  },
});

