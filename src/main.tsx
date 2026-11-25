import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { clientLog } from "./lib/api";
import { applyTheme, storedTheme } from "./lib/theme";
import { applyFontScale, storedFontScale } from "./lib/fontScale";
import "./styles/app.css";

// public/init.js 已经在首帧定过主题与字号；这里按存储再确认一次（并同步桌面窗口标题栏）。
applyTheme(storedTheme(), { persist: false });
applyFontScale(storedFontScale(), { persist: false });
document.documentElement.lang = "zh-CN";

// 前端报错也落进 Rust 日志，方便现场排查
window.addEventListener("error", (event) => {
  clientLog("error", `${event.message} @ ${event.filename}:${event.lineno}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  clientLog("error", `unhandled: ${reason}`);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
