// 直接量：8 个柱子容器与子元素的实际尺寸。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /汇总/ }).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: "shots/summary.png" });

const info = await page.evaluate(() => {
  const wrapper = Array.from(document.querySelectorAll("div")).find((el) => el.className.includes("items-stretch") && el.className.includes("gap-2"));
  if (!wrapper) return { found: false };
  const cs = getComputedStyle(wrapper);
  return {
    found: true,
    display: cs.display,
    alignItems: cs.alignItems,
    height: cs.height,
    children: Array.from(wrapper.children).slice(0, 3).map((col) => {
      const colCs = getComputedStyle(col);
      return {
        col: { alignSelf: colCs.alignSelf, height: colCs.height, display: colCs.display },
        bars: Array.from(col.children).map((bar) => ({ style: bar.getAttribute("style"), h: getComputedStyle(bar).height })),
      };
    }),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
