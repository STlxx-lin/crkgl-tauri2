// 看点击 / 双击后 React Aria 是否响应：截取事件与状态。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

await page.evaluate(() => {
  const tr = document.querySelectorAll("tbody tr")[4];
  window.__events = [];
  for (const type of ["pointerdown", "mousedown", "click", "dblclick"]) {
    tr.addEventListener(type, () => window.__events.push(type), true);
  }
});

const row = page.locator("tbody tr").nth(4);
await row.click();
await page.waitForTimeout(600);
await page.screenshot({ path: "shots/after-click.png" });
await row.click({ clickCount: 2 });
await page.waitForTimeout(900);
await page.screenshot({ path: "shots/detail.png" });

const events = await page.evaluate(() => window.__events);
const body = await page.locator("body").innerText();
console.log(JSON.stringify({ events, drawer: body.includes("改这一行") }, null, 2));
await browser.close();
