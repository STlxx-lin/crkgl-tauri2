import { defineConfig } from "vitest/config";

// 只测纯函数与存储读写，不需要浏览器环境：setupFiles 里给 `window` /
// `localStorage` / `CustomEvent` 打了个最小实现（见 src/test/setup.ts）。
// 这样跑 `npm test` 不用额外拉 jsdom / happy-dom。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
