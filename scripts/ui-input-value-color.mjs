// 验收：开单明细行里有值的输入框用主文本色（深色主题下接近白色），占位符仍是灰。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  window.__TAURI_INTERNALS__ = {
    invoke(command) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 7677, importCount: 1,
            minDate: "2025-10-30", maxDate: "2026-08-31", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "item_master":
          return ok([{ itemCode: "WG-ZCL-0001", itemName: "51101", unit: "只", lastPriceMicros: 13000, hits: 9 }]);
        case "voucher_next_no":
          return ok("20261110001");
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "suppliers_list":
        case "voucher_list":
        case "voucher_search":
        case "items_list":
          return ok([]);
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1500, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);

// 填入物料，让单位/单价自动带出
await page.locator("tbody tr").first().locator("input").nth(1).fill("WG-ZCL-0001");
await page.waitForTimeout(900);
const menu = page.locator('[role="listbox"] button').first();
if (await menu.count()) await menu.click();
await page.waitForTimeout(600);

const colors = await page.evaluate(() => {
  const tr = document.querySelector("tbody tr");
  if (!tr) return null;
  return Array.from(tr.querySelectorAll("input")).map((el) => {
    const cs = getComputedStyle(el);
    return {
      placeholder: el.placeholder,
      value: el.value,
      color: cs.color,
      placeholderRule: getComputedStyle(el, "::placeholder").color,
    };
  });
});
await page.screenshot({ path: "shots/voucher-value-color.png" });
console.log(JSON.stringify({ colors, errors }, null, 2));
await browser.close();
