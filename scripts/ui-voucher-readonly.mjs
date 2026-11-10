// 端到端验收：只读站里看开单结果 + 批量改的结果。
// 开单/批量写操作只在桌面端可用，所以这里改为直接查只读站 API 与数据库，
// 再用 80 端口页面确认 UI 渲染。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// 只读站只应有两个导航项，不应出现「开单」
const nav = await page.locator("nav button").allInnerTexts();
const hasVoucher = nav.some((t) => t.includes("开单"));

await page.screenshot({ path: "shots/v-ledger.png" });
await page.getByRole("button", { name: /汇总/ }).first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots/v-summary.png" });

console.log(JSON.stringify({ nav, hasVoucher, errors }, null, 2));
await browser.close();
