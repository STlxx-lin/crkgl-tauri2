// 验证物料选择器：输入即查、带出名称单位单价、键盘可选。
import { chromium } from "playwright";

const items = [
  { id: 1, itemCode: "WG-WJ-0716", itemName: "80 钢丝扣", category: "五金类", unit: "只", priceMicros: 400000, spec: null, itemType: "外购件", drawingNo: null, owner: null, supplier: null, remark: null, active: true },
  { id: 2, itemCode: "WG-WJ-0717", itemName: "30钢丝扣", category: "五金类", unit: "只", priceMicros: 300000, spec: null, itemType: "外购件", drawingNo: null, owner: null, supplier: null, remark: null, active: true },
  { id: 3, itemCode: "WG-LSBZ-0354", itemName: "弹垫 6", category: "螺丝标准件", unit: "只", priceMicros: 8000, spec: null, itemType: "外购件", drawingNo: null, owner: null, supplier: null, remark: null, active: true },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.exposeFunction("__searchItems", (kw) => {
  if (!kw) return items;
  return items.filter((i) => i.itemCode.includes(kw) || i.itemName.includes(kw));
});

await page.addInitScript(() => {
  const ok = (v) => Promise.resolve(v);
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      window.__calls.push({ command, args });
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 7677, importCount: 1,
            minDate: "2025-04-12", maxDate: "2026-08-31", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "2026-11-10 09:00:00" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "voucher_list":
          return ok([]);
        case "voucher_next_no":
          return ok("20261110001");
        case "suppliers_list":
          return ok([
            { id: 1, name: "万杨五金", contact: null, phone: null, remark: null, active: true, hits: 904 },
            { id: 2, name: "鼎铭自动化", contact: null, phone: null, remark: null, active: true, hits: 754 },
          ]);
        case "items_list":
          return window.__searchItems(((args || {}).keyword || "").trim()).then((list) => list);
        default:
          return ok(null);
      }
    },
  };
});

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1800);

// 点开物料选择器
const picker = page.getByPlaceholder("编码或名称").first();
await picker.click();
await page.waitForTimeout(800);
await page.screenshot({ path: "shots/picker-open.png" });

const listCount = await page.locator('[role="option"]').count();
const listText = await page.locator('[role="listbox"]').first().innerText().catch(() => "(none)");

// 输入过滤
await picker.fill("钢丝扣");
await page.waitForTimeout(900);
const filteredCount = await page.locator('[role="option"]').count();
await page.screenshot({ path: "shots/picker-filtered.png" });

// 选中第一条
await page.locator('[role="option"]').first().click();
await page.waitForTimeout(700);

const rowValues = await page.evaluate(() => {
  const tr = document.querySelector("tbody tr");
  return tr ? Array.from(tr.querySelectorAll("input")).map((i) => i.value) : [];
});
await page.screenshot({ path: "shots/picker-picked.png" });

console.log(JSON.stringify({ listCount, listText: listText.slice(0, 200), filteredCount, rowValues, errors }, null, 2));
await browser.close();
