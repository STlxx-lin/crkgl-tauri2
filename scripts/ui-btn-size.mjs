// 验证按钮尺寸是否统一：量所有可见按钮的高度与字号。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(2200);

const measure = () =>
  page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons
      .filter((b) => b.offsetParent !== null)
      .map((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return {
          text: (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 14),
          h: Math.round(r.height),
          w: Math.round(r.width),
          fs: cs.fontSize,
        };
      });
  });

const ledger = await measure();
const heights = [...new Set(ledger.map((b) => b.h))].sort((a, b) => a - b);

// 汇总页
await page.getByRole("button", { name: /汇总/ }).first().click();
await page.waitForTimeout(1600);
const summary = await measure();
const summaryHeights = [...new Set(summary.map((b) => b.h))].sort((a, b) => a - b);

await page.screenshot({ path: "shots/btn-summary.png" });
await page.getByRole("button", { name: /台账/ }).first().click();
await page.waitForTimeout(1400);
await page.screenshot({ path: "shots/btn-ledger.png" });

console.log(
  JSON.stringify(
    {
      ledgerHeights: heights,
      ledgerButtons: ledger.slice(0, 8),
      summaryHeights,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
