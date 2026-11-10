// 冒烟脚本：用 80 端口只读站渲染真实页面并截图，顺便收集控制台错误。
// 用法：node scripts/ui-probe.mjs <outDir>
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "shots");
mkdirSync(outDir, { recursive: true });

// 用本机已装的 Chromium，避免再下载一份
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));

const shots = [
  { name: "ledger", url: "http://127.0.0.1/", wait: 2500 },
];

for (const shot of shots) {
  await page.goto(shot.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(shot.wait);
  await page.screenshot({ path: `${outDir}/${shot.name}.png`, fullPage: false });
}

// 汇总页：只读站导航里第二个按钮
try {
  await page.getByRole("button", { name: /汇总/ }).click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${outDir}/summary.png` });
} catch (err) {
  errors.push(`summary click: ${err}`);
}

// 详情抽屉
await page.getByRole("button", { name: /台账/ }).click();
await page.waitForTimeout(1200);
try {
  const row = page.locator('tr[data-key]').nth(2);
  await row.dblclick();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/detail.png` });
} catch (err) {
  errors.push(`detail: ${err}`);
}

console.log("console errors:", errors.length ? errors : "none");
await browser.close();
