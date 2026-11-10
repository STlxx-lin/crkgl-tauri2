// 验收：开单明细表「物料名称」列有足够宽度，表头不换行。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
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
        case "item_master":
          return ok([{ itemCode: "WG-ODL-0040", itemName: "亚德客电磁阀4v210-08B(24V)", unit: "个", lastPriceMicros: 420000, hits: 12, stockQty: 3 }]);
        case "voucher_list":
          return ok([{ id: 1, kind: "in", docNo: "20261110001", docDate: "2026-11-10", partner: null, owner: null, rowCount: 1, amountCents: 46200, createdAt: "x", firstItem: "亚德客电磁阀4v210-08B(24V)" }]);
        case "voucher_next_no":
          return ok("20261110002");
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

// 填入长物料名，看是否被截
await page.locator("tbody tr").first().locator("input").nth(1).fill("WG-ODL-0040");
await page.waitForTimeout(800);
const opt = page.locator('[role="listbox"] button').first();
if (await opt.count()) await opt.click();
await page.waitForTimeout(500);

const geom = await page.evaluate(() => {
  const th = Array.from(document.querySelectorAll("thead th")).find((el) => el.innerText.trim() === "物料名称");
  const inputs = Array.from(document.querySelectorAll("tbody tr input"));
  const nameInput = inputs.find((i) => i.placeholder === "物料名称");
  const table = document.querySelector("table");
  const wrap = document.querySelector(".scroll-fade-wrap") ?? table?.parentElement;
  return {
    headerWidth: th ? Math.round(th.getBoundingClientRect().width) : null,
    headerLines: th ? Math.round(th.getBoundingClientRect().height / parseFloat(getComputedStyle(th).lineHeight || "18")) : null,
    nameWidth: nameInput ? Math.round(nameInput.getBoundingClientRect().width) : null,
    nameValue: nameInput?.value ?? null,
    nameScrolls: nameInput ? nameInput.scrollWidth > nameInput.clientWidth + 1 : null,
    tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
  };
});
await page.screenshot({ path: "shots/voucher-name-width.png" });
console.log(JSON.stringify({ geom, errors }, null, 2));
await browser.close();
