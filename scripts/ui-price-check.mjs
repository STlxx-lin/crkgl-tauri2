// 验证丝级单价（0.0032 元）在界面上是否完整显示。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1800);

// 搜一个丝级单价物料
await page.getByLabel("搜索单据、物料、供应商").fill("弹垫");
await page.waitForTimeout(1400);
await page.screenshot({ path: "shots/price-precision.png" });

const rows = await page.evaluate(() =>
  Array.from(document.querySelectorAll("tbody tr"))
    .slice(0, 6)
    .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.innerText.trim()).filter(Boolean)),
);
console.log(JSON.stringify(rows, null, 2));
await browser.close();
