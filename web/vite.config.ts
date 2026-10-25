import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { demoApi } from "./server/api.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react(), demoApi(repoRoot)],
  server: { port: 5173 },
});
