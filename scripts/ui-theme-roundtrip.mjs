// 来回切换：浅 → 深 → 浅，确认 token 全部跟随、无残留。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const read = () =>
  page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    body: getComputedStyle(document.body).backgroundColor,
    sidebar: getComputedStyle(document.querySelector("aside")).backgroundColor,
    text: getComputedStyle(document.querySelector("h1")).color,
    stored: localStorage.getItem("ledger.theme"),
  }));

const start = await read();
await page.getByRole("button", { name: /浅色/ }).click();
await page.waitForTimeout(500);
const light = await read();
await page.screenshot({ path: "shots/theme-light.png" });

await page.getByRole("button", { name: /深色/ }).click();
await page.waitForTimeout(500);
const dark = await read();
await page.screenshot({ path: "shots/theme-dark.png" });

console.log(JSON.stringify({ start, light, dark, errors }, null, 2));
await browser.close();
