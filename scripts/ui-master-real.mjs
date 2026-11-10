// 用真实数据看基础资料页（只读站没有该页，所以走 Tauri 桩仅供观察布局）。
// 这里改为：直接查真实接口，确认 itemType 字段真的返回了。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 只读站没有 items 接口，用页面里的 fetch 验证读取站不暴露它
const probe = await page.evaluate(async () => {
  const out = {};
  for (const p of ["/api/items", "/api/master/stats", "/api/doc/search"]) {
    try {
      const r = await fetch(p);
      out[p] = r.status;
    } catch (e) {
      out[p] = String(e);
    }
  }
  return out;
});
console.log("READONLY PROBES:", JSON.stringify(probe));
await browser.close();
