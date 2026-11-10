import { chromium } from "playwright";

// 桩 Tauri 桥：桌面端两个内部页（导入、只读站）在浏览器里画出来做布局验收。
// 只在截图脚本里使用，不参与生产构建。
const stub = () => {
  const ok = (value) => Promise.resolve(value);
  const filters = [
    { column: 0, header: "入库时间", field: "doc_date" },
    { column: 1, header: "单据编号", field: "doc_no" },
    { column: 2, header: "送货单号", field: "delivery_no" },
    { column: 3, header: "物料编码", field: "item_code" },
    { column: 4, header: "物料名称", field: "item_name" },
    { column: 5, header: "单位", field: "unit" },
    { column: 6, header: "数量", field: "qty" },
    { column: 7, header: "单价", field: "price" },
    { column: 8, header: "合计", field: "amount" },
    { column: 9, header: "备注", field: "remark" },
    { column: 10, header: "供应商名称", field: "partner" },
    { column: 11, header: "采购人", field: "buyer" },
    { column: 12, header: "辅助列", field: null },
  ];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0",
            schemaVersion: 1,
            dbPath: "C:\\Users\\admin\\AppData\\Roaming\\coldcoffee.warehouse.ledger\\ledger.db",
            rowCount: 7677,
            importCount: 1,
            minDate: "2025-04-12",
            maxDate: "2026-08-31",
            inRows: 5887,
            outRows: 1790,
            web: {
              enabled: true,
              listening: true,
              port: 80,
              requestedPort: 80,
              error: null,
              urls: ["http://127.0.0.1:80/", "http://192.168.0.107:80/"],
              staticReady: true,
              startedAt: "2026-11-09 15:40:02",
            },
            startupImport: null,
            lastError: null,
            sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: ["乾力车间", "MQ"], partners: [], buyers: ["严兰兰", "周梓棋"], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "import_history":
          return ok([
            { id: 1, fileName: "仓库出入库明细_5611_Modified.xlsm", fileHash: "9f2c", importedAt: "2026-11-09 15:40:06", rowCount: 7677, skippedCount: 0, note: null, liveRows: 7677 },
          ]);
        case "import_inspect":
          return ok({
            path: "E:\\2025\\Trae2\\crkgl-tauri2\\仓库出入库明细_5611_Modified.xlsm",
            fileName: "仓库出入库明细_5611_Modified.xlsm",
            sizeBytes: 1237976,
            sheets: [
              { name: "供应商名称", rows: 161, nonEmptyRows: 161, detail: false, note: "不像明细表", headers: [], sample: [] },
              { name: "入库明细", rows: 5888, nonEmptyRows: 5888, detail: true, note: "明细表：5887 行数据", headers: filters, sample: [] },
              { name: "出库明细", rows: 1791, nonEmptyRows: 1791, detail: true, note: "明细表：1790 行数据", headers: filters.slice(0, 10), sample: [] },
              { name: "库存明细", rows: 2886, nonEmptyRows: 2886, detail: false, note: "不像明细表", headers: [], sample: [] },
            ],
          });
        case "import_preview":
          return ok({
            totalRows: 7677,
            totalIssues: 14,
            flaggedRows: 3346,
            sheets: [
              { name: "入库明细", kind: "in", rows: 5887, skipped: 0, flagged: 1556, issues: [{ sheet: "入库明细", rowNo: 1004, message: "数量为空" }], sample: [
                { rowNo: 2, docDate: "2025-10-30", docNo: "20251030200", itemCode: "WG-WJ-0292", itemName: "M10*80膨胀螺丝", qty: 2.5, amountCents: 1500, flags: [] },
                { rowNo: 3, docDate: "2025-10-30", docNo: "20251030200", itemCode: "WG-WJ-0293", itemName: "Φ12*150圆头钻头", qty: 1, amountCents: 600, flags: [] },
              ] },
              { name: "出库明细", kind: "out", rows: 1790, skipped: 0, flagged: 1790, issues: [{ sheet: "出库明细", rowNo: 3, message: "数量不是数字：`-`" }], sample: [
                { rowNo: 2, docDate: "2025-04-12", docNo: "1", itemCode: "手电筒（头灯）", itemName: "百忆美702", qty: 2, amountCents: null, flags: ["no_amount"] },
              ] },
            ],
          });
        case "web_status":
          return ok({ enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: ["http://127.0.0.1:80/", "http://192.168.0.107:80/"], staticReady: true, startedAt: "2026-11-09 15:40:02" });
        case "web_access_log":
          return ok([
            { at: "2026-11-09 15:44:10", ip: "192.168.0.23", path: "GET /api/ledger/page", status: 200 },
            { at: "2026-11-09 15:44:12", ip: "192.168.0.23", path: "GET /api/ledger/facets", status: 200 },
            { at: "2026-11-09 15:45:01", ip: "192.168.0.88", path: "GET /api/ledger/export.csv", status: 200 },
            { at: "2026-11-09 15:46:33", ip: "203.0.113.9", path: "/", status: 403 },
          ]);
        case "ledger_page":
          return ok({ rows: [], total: 7677, page: 1, pageSize: 100, totals: { rows: 0, inRows: 0, outRows: 0, amountInCents: 0, amountOutCents: 0, qtyIn: 0, qtyOut: 0, docCount: 0, itemCount: 0 } });
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(stub);
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

await page.getByRole("button", { name: /导入/ }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: "shots/import.png" });

// 模拟选中文件后进入映射步骤
await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("import_inspect", { path: "x" }));
await page.waitForTimeout(300);

await page.getByRole("button", { name: /只读站/ }).first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/remote.png" });

await browser.close();
console.log("done");
