// 抓 DOM：确认图表容器的实际高度与柱子的计算高度，判断是样式还是数据问题。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /汇总/ }).first().click();
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const wrapper = document.querySelector(".relative.flex.h-56");
  if (!wrapper) return { found: false };
  const bars = Array.from(wrapper.querySelectorAll("div")).slice(0, 8).map((el) => ({
    cls: el.className.slice(0, 60),
    h: el.style.height,
    rect: el.getBoundingClientRect().height,
  }));
  return {
    found: true,
    wrapper: wrapper.getBoundingClientRect().height,
    display: getComputedStyle(wrapper).display,
    align: getComputedStyle(wrapper).alignItems,
    bars,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
