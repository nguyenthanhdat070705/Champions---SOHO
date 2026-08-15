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
    // In dev the SPA runs on :5173 and the combined API server on :3000.
    // Proxy the Functional 03 API + PayOS routes so same-origin fetch works
    // exactly as it will in production (combined server serves both).
    proxy: {
      "/v1": "http://localhost:3000",
      "/api": "http://localhost:3000",
    },
  },
});
