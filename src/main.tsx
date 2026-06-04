import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// macOS-only chrome: translucent vibrancy sidebar + overlay title bar.
// Gated to the real Tauri webview on macOS so plain-browser dev and Windows stay untouched.
const isTauri = "__TAURI_INTERNALS__" in window;
const isMac = navigator.userAgent.toLowerCase().includes("mac");
if (isTauri && isMac) {
  document.documentElement.classList.add("is-macos");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
