import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { type Variant } from "./App";
import "./styles.css";

// /demo is the guided demo; everything else is the plain policy and call tester.
const variant: Variant = /^\/demo\/?$/.test(location.pathname) ? "demo" : "mvp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App variant={variant} />
  </StrictMode>,
);
