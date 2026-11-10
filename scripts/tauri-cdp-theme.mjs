// 通过 WebView2 的 CDP 调试端口，直接在真实 Tauri 窗口里点「浅色」并读回状态。
import { chromium } from "playwright";

const port = process.env.CDP_PORT ?? "9222";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const contexts = browser.contexts();
const pages = contexts.flatMap((c) => c.pages());
console.log("pages:", pages.map((p) => p.url()));

const page = pages.find((p) => p.url().includes("tauri.localhost") || p.url().startsWith("http"));
if (!page) {
  console.log("no page found");
  await browser.close();
  process.exit(1);
}

const read = () =>
  page.evaluate(() => ({
    htmlClass: document.documentElement.className,
    stored: localStorage.getItem("ledger.theme"),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    slider: (() => {
      const g = document.querySelector('[role="group"][aria-label="主题"]');
      const s = g?.querySelector("span[aria-hidden]");
      const b = g?.querySelector("button");
      return g && s && b
        ? {
            group: Math.round(g.getBoundingClientRect().width),
            slider: Math.round(s.getBoundingClientRect().width),
            button: Math.round(b.getBoundingClientRect().width),
            sliderLeft: Math.round(s.getBoundingClientRect().left - g.getBoundingClientRect().left),
          }
        : null;
    })(),
    pressed: Array.from(document.querySelectorAll('[role="group"][aria-label="主题"] button')).map((b) => ({
      t: b.textContent?.trim(),
      p: b.getAttribute("aria-pressed"),
    })),
  }));

console.log("before:", JSON.stringify(await read()));
await page.getByRole("button", { name: /浅色/ }).click();
await page.waitForTimeout(700);
console.log("after :", JSON.stringify(await read()));
await page.getByRole("button", { name: /深色/ }).click();
await page.waitForTimeout(700);
console.log("back  :", JSON.stringify(await read()));

await browser.close();
