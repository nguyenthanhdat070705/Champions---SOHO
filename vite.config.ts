import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SPA build → dist/. The combined Node server (server/index.js) serves dist/
// on $PORT in production and also hosts the PayOS API endpoints.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: true,
  },
});
