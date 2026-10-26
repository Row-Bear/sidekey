import "./local/shim.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { type Variant } from "./App";
import { STATIC } from "./build";
import "./styles.css";

// /demo is the guided demo; everything else is the plain policy and call tester.
// The app may be served from a sub-path (GitHub Pages), so the base is dropped before looking at the route.
const route = location.pathname.slice(import.meta.env.BASE_URL.length - 1);
const variant: Variant = !STATIC && /^\/demo\/?$/.test(route) ? "demo" : "mvp";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App variant={variant} />
  </StrictMode>,
);
