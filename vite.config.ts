import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  },
  // Never expose the broad TAURI_* namespace to browser code: it includes
  // release-signing secrets such as TAURI_SIGNING_PRIVATE_KEY. Tauri's public
  // frontend build metadata uses the narrower TAURI_ENV_* namespace.
  envPrefix: ["VITE_", "TAURI_ENV_"]
});
