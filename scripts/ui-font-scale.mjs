// 验收：字号四档切换，根字号、正文与表格实际字号一起变，刷新后保持。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push({
      id: i + 1, kind: "in", docDate: "2026-09-01", docNo: "20260901001", deliveryNo: "0023378",
      itemCode: `WG-${i}`, itemName: `测试物料 ${i}`, spec: null, unit: "个", qty: 10,
      priceMicros: 15000, amountCents: 1500, partner: "万杨五金", owner: null, buyer: "严兰兰",
      receiver: null, remark: null, flags: [], rowNo: i + 1,
    });
  }
  window.__TAURI_INTERNALS__ = {
    invoke(command) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 6, importCount: 1,
            minDate: "2026-09-01", maxDate: "2026-09-02", inRows: 6, outRows: 0,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_page":
          return ok({ rows, total: rows.length, page: 1, pageSize: 100, totals: { rows: 6, inRows: 6, outRows: 0, amountInCents: 9000, amountOutCents: 0, qtyIn: 60, qtyOut: 0, docCount: 1, itemCount: 6 } });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 6, inRows: 6, outRows: 0 });
        case "suppliers_list":
        case "voucher_list":
        case "voucher_search":
        case "items_list":
        case "import_history":
        case "web_access_log":
          return ok([]);
        case "voucher_next_no":
          return ok("20261110001");
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

const measure = () =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement).fontSize;
    const cell = document.querySelector("tbody td");
    const cellSize = cell ? getComputedStyle(cell).fontSize : null;
    const table = document.querySelector("table");
    const tableSize = table ? getComputedStyle(table).fontSize : null;
    return { root, cell: cellSize, table: tableSize };
  });

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1300);
await page.getByRole("button", { name: /^台账/ }).first().click();
await page.waitForTimeout(1200);

const initial = await measure();
const results = [];
for (const label of ["小", "大", "特大", "标准"]) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(500);
  results.push({ label, ...(await measure()) });
}
await page.getByRole("button", { name: "大", exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "shots/font-large.png" });

// 表格比容器宽时应能横向滚动，右侧列不会丢
const scrollInfo = await page.evaluate(() => {
  // .ledger-table 是滚动层；react-aria 的 Table 还会在外面套一层 overflow-x-auto
  const wrap = document.querySelector(".ledger-table");
  const table = document.querySelector("table");
  if (!wrap) return null;
  const before = wrap.scrollLeft;
  wrap.scrollLeft = wrap.scrollWidth;
  const after = wrap.scrollLeft;
  return {
    scrollWidth: wrap.scrollWidth,
    clientWidth: wrap.clientWidth,
    scrolled: after > before,
    tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
    lastColVisible: (() => {
      const th = Array.from(document.querySelectorAll("thead th")).at(-1);
      if (!th) return null;
      const r = th.getBoundingClientRect();
      const c = wrap.getBoundingClientRect();
      return r.right <= c.right + 1;
    })(),
  };
});

const beforeReload = await measure();
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /^台账/ }).first().click();
await page.waitForTimeout(900);
const afterReload = await measure();

console.log(JSON.stringify({ initial, results, scrollInfo, beforeReload, afterReload, errors }, null, 2));
await browser.close();
