// 找出点击行时事件落在谁身上：打印命中元素与祖先链，判断是否有遮罩层。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const row = page.locator("tbody tr").nth(4);
const box = await row.boundingBox();
const info = await page.evaluate(({ x, y }) => {
  const hit = document.elementFromPoint(x, y);
  const chain = [];
  let node = hit;
  for (let i = 0; i < 6 && node; i += 1) {
    chain.push({
      tag: node.tagName,
      role: node.getAttribute("role"),
      cls: (node.className || "").toString().slice(0, 70),
      pe: getComputedStyle(node).pointerEvents,
    });
    node = node.parentElement;
  }
  return { hitTag: hit ? hit.tagName : null, chain };
}, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
console.log(JSON.stringify(info, null, 2));
await browser.close();
