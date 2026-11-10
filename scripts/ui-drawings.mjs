// 验证图号页：切到「缺图号」、改一条图号、确认载荷。
import { chromium } from "playwright";

const items = [
  { id: 21, itemCode: "基础-21", itemName: "YW-01", category: null, unit: "件", priceMicros: null, spec: null, itemType: "加工件", drawingNo: null, owner: null, supplier: null, remark: null, active: true },
  { id: 22, itemCode: "基础-22", itemName: "YW-02", category: null, unit: "件", priceMicros: null, spec: null, itemType: "加工件", drawingNo: null, owner: null, supplier: null, remark: null, active: true },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
const logs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));

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
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "2026-11-10 10:00:00" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "master_stats":
          return ok({
            items: 4390, itemsActive: 4390, suppliers: 162,
            withDrawing: 224, missingDrawing: 23,
            itemTypes: [{ category: "外购件", count: 631 }, { category: "加工件", count: 244 }, { category: "未分类", count: 3515 }],
            categories: [{ category: "原材料", count: 1317 }],
          });
        case "items_list": {
          const withDrawing = (args || {}).withDrawing;
          return ok(withDrawing === false ? [
            { id: 21, itemCode: "基础-21", itemName: "YW-01", category: null, unit: "件", priceMicros: null, spec: null, itemType: "加工件", drawingNo: null, owner: null, supplier: null, remark: null, active: true },
            { id: 22, itemCode: "基础-22", itemName: "YW-02", category: null, unit: "件", priceMicros: null, spec: null, itemType: "加工件", drawingNo: null, owner: null, supplier: null, remark: null, active: true },
          ] : []);
        }
        case "items_count":
          return ok((args || {}).withDrawing === false ? items.length : 224);
        case "suppliers_list":
          return ok([]);
        case "item_update":
          return ok(null);
        default:
          return ok(null);
      }
    },
  };
});

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1600);
console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
console.log("NAV:", JSON.stringify(await page.locator("nav button").allInnerTexts()));
await page.getByRole("button", { name: /基础资料/ }).first().click();
await page.waitForTimeout(1000);
await page.getByRole("tab", { name: /图号/ }).click();
await page.waitForTimeout(800);

// 切到「缺图号」
await page.getByRole("radio", { name: "缺图号" }).click().catch(async () => {
  await page.getByText("缺图号", { exact: true }).first().click();
});
await page.waitForTimeout(1000);
await page.screenshot({ path: "shots/drawings-missing.png" });

const rowCount = await page.locator("tbody tr").count();

// 点第一行的编辑
await page.locator("tbody tr").first().getByRole("button").first().click();
await page.waitForTimeout(700);
const dialog = page.locator('[role="dialog"]').last();
await dialog.locator("input").first().fill("YW-01-DWG");
await page.screenshot({ path: "shots/drawings-dialog.png" });
await dialog.getByRole("button", { name: /^保存$/ }).click();
await page.waitForTimeout(900);

const updateCall = await page.evaluate(() => window.__calls.find((c) => c.command === "item_update") || null);
console.log(JSON.stringify({ rowCount, updateCall, errors }, null, 2));
await browser.close();
