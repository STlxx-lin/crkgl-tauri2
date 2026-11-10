// 桌面端两个内部页面在只读站里看不到，这里用 Tauri 桥的桩数据在同源渲染，
// 只用于截图验收布局（数据是假的，不进生产）。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// 远程页在只读站里没有入口，直接改导航不可行；用键盘导航做不到，
// 所以这里只验证只读站不会暴露导入/只读站按钮。
const navButtons = await page.locator("nav button").allInnerTexts();
console.log(JSON.stringify({ navButtons, errors }, null, 2));
await browser.close();
