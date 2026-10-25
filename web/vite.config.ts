import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { demoApi } from "./server/api.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react(), demoApi(repoRoot)],
  // The demo API can spend testnet funds and rewrite .env, so it is never exposed on the network.
  server: { host: "localhost", port: 5173 },
});
