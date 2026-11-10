// 验收：开单页「物料编码」候选来自已入库数据（item_master 带 inboundOnly）。
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
            { itemCode: "WG-IN-001", itemName: "入库过的外卡", unit: "个", lastPriceMicros: 30000, hits: 42 },
            { itemCode: "WG-IN-002", itemName: "入库过的轴承", unit: "只", lastPriceMicros: 105000, hits: 8 },
          ]);
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
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);

// 聚焦物料编码，候选应来自 item_master
await page.locator("tbody tr").first().locator("input").nth(1).click();
await page.waitForTimeout(900);

const result = await page.evaluate(() => {
  const calls = window.__calls.filter((c) => c.command === "item_master");
  const menu = document.querySelector('[role="listbox"]') ?? document.body;
  const text = menu.innerText;
  return {
    itemMasterCalls: calls.length,
    inboundOnlyFlags: calls.map((c) => c.args?.inboundOnly ?? c.args?.args?.inboundOnly ?? null),
    listItemsCalls: window.__calls.filter((c) => c.command === "items_list").length,
    menuHasInbound: text.includes("入库过的外卡"),
    menuHasOutboundOnly: /只出库/.test(text),
  };
});
await page.screenshot({ path: "shots/item-picker-inbound.png" });
console.log(JSON.stringify({ result, errors }, null, 2));
await browser.close();
