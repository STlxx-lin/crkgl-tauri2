// 详情抽屉验收：点一行，截图，并确认右侧抽屉出现。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const row = page.locator("tbody tr").nth(4);
await row.dblclick();
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/detail.png" });

const body = await page.locator("body").innerText();
const hasDrawer = body.includes("来源") && body.includes("改这一行");
console.log(JSON.stringify({ hasDrawer, tail: body.slice(-300) }, null, 2));
await browser.close();
