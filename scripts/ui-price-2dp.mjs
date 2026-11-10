// 验收：载入已有单据时单价保留两位小数，数量列变窄。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  const detail = {
    id: 51, kind: "in", docNo: "20261110001", docDate: "2026-11-10",
    partner: null, deliveryNo: null, buyer: "严兰兰", owner: null, receiver: null,
    remark: null, rowCount: 1, amountCents: 46200, createdAt: "x", sheet: "voucher:in",
    lines: [{ id: 1, ledgerId: 1, deliveryNo: null, itemCode: "WG-ODL-0040",
      itemName: "亚德客电磁阀4v210-08B(24V)", unit: "个", qty: 11,
      priceMicros: 420000, amountCents: 46200, remark: null }],
  };
  window.__TAURI_INTERNALS__ = {
    invoke(command) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 7678, importCount: 1,
            minDate: "2025-04-12", maxDate: "2026-11-10", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "voucher_list":
          return ok([{ id: 51, kind: "in", docNo: "20261110001", docDate: "2026-11-10", partner: null, owner: null, rowCount: 1, amountCents: 46200, createdAt: "x", firstItem: "亚德客电磁阀4v210-08B(24V)" }]);
        case "voucher_get":
          return ok(detail);
        case "voucher_next_no":
          return ok("20261110002");
        case "item_master":
          return ok([]);
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "suppliers_list":
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
const page = await browser.newPage({ viewport: { width: 1463, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);

// 打开列表里的单据详情，再点「载入编辑」
await page.getByRole("button", { name: /20261110001/ }).first().click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: /载入编辑/ }).click();
await page.waitForTimeout(900);

const result = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll("tbody tr input"));
  const th = (label) => Array.from(document.querySelectorAll("thead th")).find((el) => el.innerText.trim() === label);
  return {
    price: inputs.find((i) => i.placeholder === "0.00")?.value ?? null,
    qty: inputs.find((i) => i.placeholder === "0")?.value ?? null,
    qtyColWidth: th("数量") ? Math.round(th("数量").getBoundingClientRect().width) : null,
    priceColWidth: th("单价") ? Math.round(th("单价").getBoundingClientRect().width) : null,
    total: Array.from(document.querySelectorAll("tfoot td, tbody td")).map((t) => t.innerText).find((t) => t.includes("¥")) ?? null,
  };
});
await page.screenshot({ path: "shots/price-2dp.png" });
console.log(JSON.stringify({ result, errors }, null, 2));
await browser.close();
