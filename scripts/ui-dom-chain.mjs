// 查清柱子为什么高度为 0：看每一层父链的 display / align-items / height。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /汇总/ }).first().click();
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const bar = Array.from(document.querySelectorAll("div")).find((el) => el.className.includes("bg-accent-500") && el.className.includes("max-w-6"));
  if (!bar) return { found: false };
  const chain = [];
  let node = bar;
  for (let i = 0; i < 6 && node; i += 1) {
    const cs = getComputedStyle(node);
    chain.push({
      tag: node.tagName,
      cls: (node.className || "").toString().slice(0, 80),
      display: cs.display,
      align: cs.alignItems,
      height: cs.height,
      rectH: Math.round(node.getBoundingClientRect().height),
      inline: node.getAttribute("style"),
    });
    node = node.parentElement;
  }
  return { found: true, chain };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
