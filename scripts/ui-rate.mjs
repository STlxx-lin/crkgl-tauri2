// 连续打 120 次，统计状态码分布，打印前几次 429 的时间点。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage();
await page.goto("http://127.0.0.1/", { waitUntil: "domcontentloaded" });
const codes = await page.evaluate(async () => {
  const out = [];
  for (let i = 0; i < 120; i += 1) {
    const res = await fetch("/api/ledger/facets");
    out.push(res.status);
  }
  return out;
});
const summary = codes.reduce((acc, code) => {
  acc[code] = (acc[code] ?? 0) + 1;
  return acc;
}, {});
console.log(JSON.stringify({ summary, firstNon200: codes.findIndex((c) => c !== 200) }, null, 2));
await browser.close();
