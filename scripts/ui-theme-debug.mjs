// 复现「切浅色无效」：点击后读取 class、存储、以及各层计算色。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("console", (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
page.on("pageerror", (err) => logs.push(`pageerror: ${err}`));

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const before = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  stored: localStorage.getItem("ledger.theme"),
  bodyBg: getComputedStyle(document.body).backgroundColor,
  tokens: {
    full: getComputedStyle(document.documentElement).getPropertyValue("--color-background-full"),
    text: getComputedStyle(document.documentElement).getPropertyValue("--color-text-primary"),
  },
}));

// 找按钮并点击
const btn = page.getByRole("button", { name: /浅色/ }).first();
await btn.click();
await page.waitForTimeout(600);

const after = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  stored: localStorage.getItem("ledger.theme"),
  bodyBg: getComputedStyle(document.body).backgroundColor,
  pressed: Array.from(document.querySelectorAll('[role="group"][aria-label="主题"] button')).map((b) => ({
    text: b.textContent?.trim(),
    pressed: b.getAttribute("aria-pressed"),
  })),
  tokens: {
    full: getComputedStyle(document.documentElement).getPropertyValue("--color-background-full"),
    text: getComputedStyle(document.documentElement).getPropertyValue("--color-text-primary"),
  },
}));

console.log(JSON.stringify({ before, after, logs: logs.slice(-6) }, null, 2));
await browser.close();
