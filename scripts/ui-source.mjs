// 查 /api/health 与页面来源，确认实际服务的 dist 目录。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const responses = [];
page.on("response", (res) => {
  if (res.url().includes(".js") || res.url().includes(".css")) responses.push([res.status(), res.url()]);
});
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /汇总/ }).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: "shots/summary.png" });
const health = await page.evaluate(async () => (await fetch("/api/health")).json());
console.log(JSON.stringify({ responses, health }, null, 2));
await browser.close();
