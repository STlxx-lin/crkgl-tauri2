// 多宽度下看布局：主题滑块是否贴合按钮、页头动作是否被挤出、表格是否溢出。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const widths = [1440, 1100, 900, 700];
const results = [];

for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const info = await page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="主题"]');
    const slider = group?.querySelector('span[aria-hidden]');
    const buttons = group ? Array.from(group.querySelectorAll("button")) : [];
    const header = document.querySelector("h1")?.closest("header");
    const actions = header?.querySelector("div:last-child");
    return {
      slider: slider ? Math.round(slider.getBoundingClientRect().width) : null,
      buttons: buttons.map((b) => Math.round(b.getBoundingClientRect().width)),
      groupWidth: group ? Math.round(group.getBoundingClientRect().width) : null,
      docScrollW: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      headerScrollW: header ? header.scrollWidth : null,
      headerClientW: header ? header.clientWidth : null,
      actionsRight: actions ? Math.round(actions.getBoundingClientRect().right) : null,
    };
  });
  results.push({ width, ...info });
  await page.screenshot({ path: `shots/w-${width}.png` });
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
