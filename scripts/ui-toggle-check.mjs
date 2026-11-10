// 验证主题滑块是否贴合按钮，并截图两种状态。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const measure = () =>
  page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="主题"]');
    const slider = group?.querySelector('span[aria-hidden]');
    const buttons = group ? Array.from(group.querySelectorAll("button")) : [];
    const g = group?.getBoundingClientRect();
    const s = slider?.getBoundingClientRect();
    return {
      group: g ? { w: Math.round(g.width), h: Math.round(g.height) } : null,
      slider: s ? { w: Math.round(s.width), h: Math.round(s.height), left: Math.round(s.left - (g?.left ?? 0)) } : null,
      buttons: buttons.map((b) => ({ w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })),
    };
  });

const darkState = await measure();
const clip = await page.locator('[role="group"][aria-label="主题"]').boundingBox();
await page.screenshot({ path: "shots/toggle-dark.png", clip: { x: clip.x - 8, y: clip.y - 8, width: clip.width + 16, height: clip.height + 16 } });

await page.getByRole("button", { name: /浅色/ }).click();
await page.waitForTimeout(500);
const lightState = await measure();
await page.screenshot({ path: "shots/toggle-light.png", clip: { x: clip.x - 8, y: clip.y - 8, width: clip.width + 16, height: clip.height + 16 } });

console.log(JSON.stringify({ darkState, lightState }, null, 2));
await browser.close();
