import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 桌面端（tauri dev）与 80 端口只读站点共用一套源码，靠 build mode 区分产物目录：
//   npm run build         → dist/         Tauri 打进安装包
//   npm run build:remote  → dist-remote/  由 Rust 静态目录对外提供（只读）
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    __REMOTE_MODE__: JSON.stringify(mode === "remote"),
  },
  // 静态资源走绝对路径：80 端口服务把 index.html 回落到任意深层路由
  base: "/",
  clearScreen: false,
  server: {
    // 1422 落在 Windows 保留段（netsh excludedportrange protocol=tcp 显示 1420-1519，
    // Hyper-V/WSL NAT 占用），绑定 ::1:1422 直接 EACCES。改用 Vite 默认端口 5173
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:80",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: mode === "remote" ? "dist-remote" : "dist",
    emptyOutDir: true,
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
}));
