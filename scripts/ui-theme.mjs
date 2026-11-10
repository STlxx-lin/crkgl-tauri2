// 切到浅色主题，逐页截图，顺便看一眼首帧是否有深色闪动。
import { chromium } from "playwright";

const out = "shots";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 点侧栏底部的「浅色」
await page.getByRole("button", { name: /浅色/ }).first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/light-ledger.png` });

const state = await page.evaluate(() => ({
  dark: document.documentElement.classList.contains("dark"),
  stored: localStorage.getItem("ledger.theme"),
  scheme: document.documentElement.style.colorScheme,
  bg: getComputedStyle(document.body).backgroundColor,
}));

await page.getByRole("button", { name: /汇总/ }).first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/light-summary.png` });

// 详情抽屉
await page.getByRole("button", { name: /台账/ }).first().click();
await page.waitForTimeout(1000);
await page.locator("tbody tr").nth(3).click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/light-detail.png` });

// 刷新后应保持浅色（验证持久化 + 首帧脚本）
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const afterReload = await page.evaluate(() => document.documentElement.classList.contains("dark"));
await page.screenshot({ path: `${out}/light-after-reload.png` });

console.log(JSON.stringify({ state, afterReloadDark: afterReload, errors }, null, 2));
await browser.close();
