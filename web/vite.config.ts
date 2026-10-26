import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { demoApi } from "./server/api.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Static hosts such as GitHub Pages serve 404.html for unknown paths, so a copy of the app there makes /demo work.
const spaFallback = (): Plugin => ({
  name: "spa-fallback",
  apply: "build",
  closeBundle() {
    const dist = fileURLToPath(new URL("./dist", import.meta.url));
    copyFileSync(`${dist}/index.html`, `${dist}/404.html`);
  },
});

export default defineConfig({
  // Set VITE_BASE=/repo-name/ when hosting under a sub-path.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), demoApi(repoRoot), spaFallback()],
  // The demo API can spend testnet funds and rewrite .env, so it is never exposed on the network.
  server: { host: "localhost", port: 5173 },
});
