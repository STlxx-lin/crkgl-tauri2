import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { clientLog } from "./lib/api";
import { applyTheme, storedTheme } from "./lib/theme";
import "./styles/app.css";

// index.html 里的内联脚本已经定过首帧主题；这里只按存储再确认一次（不写盘）。
applyTheme(storedTheme(), { persist: false });
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
