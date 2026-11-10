// 验收：出库单的物料候选只含有库存的物料，并显示库存量。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      window.__calls.push({ command, args });
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 7677, importCount: 1,
            minDate: "2025-10-30", maxDate: "2026-08-31", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "item_master":
          return ok([
            { itemCode: "WG-ODL-0040", itemName: "亚德客电磁阀4v210-08B(24V)", unit: "个", lastPriceMicros: 420000, hits: 12, stockQty: 3 },
            { itemCode: "WG-LSBZ-0074", itemName: "M8*25鹏驰12.9级内六角螺丝", unit: "只", lastPriceMicros: 1740, hits: 30, stockQty: 126 },
          ]);
        case "voucher_next_no":
          return ok("20261110001");
        case "ledger_facets":
          return ok({ owners: ["乾力车间"], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "suppliers_list":
        case "voucher_list":
        case "voucher_search":
          return ok([]);
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
console.log("BTNS", JSON.stringify(await page.getByRole("button").allInnerTexts()));
await page.getByRole("button", { name: /^新出库单$/ }).click();
await page.waitForTimeout(1000);
console.log("HAS_OUT_TITLE", await page.getByText("出库单", { exact: true }).count());
await page.screenshot({ path: "shots/_outbound-before.png" });

// 出库单没有「送货单号」列，第 1 个输入框才是物料编码
await page.locator('input[placeholder="选有库存的物料"]').first().click();
await page.waitForTimeout(1000);

const result = await page.evaluate(() => {
  const calls = window.__calls.filter((c) => c.command === "item_master");
  const listbox = document.querySelector('[role="listbox"]');
  return {
    inStockFlags: calls.map((c) => c.args?.inStockOnly ?? c.args?.args?.inStockOnly ?? null),
    menuText: listbox ? listbox.innerText.replace(/\n/g, " | ") : null,
    hasStockBadge: Boolean(listbox && /库存/.test(listbox.innerText)),
  };
});
await page.screenshot({ path: "shots/outbound-stock.png" });
console.log(JSON.stringify({ result, errors }, null, 2));
await browser.close();
