// 单据查询验收：桩桥 + 真实页面，验证查询列表、点开导入单据的只读明细。
import { chromium } from "playwright";

const hits = [
  { docNo: "20260831206", kind: "in", docDate: "2026-08-31", partner: "智远自动化", owner: null, buyer: "周梓棋", deliveryNo: "2026070475", rowCount: 7, amountCents: 2426000, source: "import", voucherId: null },
  { docNo: "20260831205", kind: "in", docDate: "2026-08-31", partner: "万杨五金", owner: null, buyer: "严兰兰", deliveryNo: "0023378", rowCount: 2, amountCents: 18000, source: "import", voucherId: null },
  { docNo: "20260901001", kind: "out", docDate: "2026-09-01", partner: null, owner: "乾力车间", buyer: null, deliveryNo: null, rowCount: 3, amountCents: 0, source: "voucher", voucherId: 5 },
];

const lines = [
  { id: 1, kind: "in", docDate: "2026-08-31", docNo: "20260831206", deliveryNo: "2026070475", itemCode: "WG-DQ-0073", itemName: "伺服驱动器DS5C2-42P3-PTA", spec: null, unit: "台", qty: 9, priceMicros: 22000000, amountCents: 1980000, remark: null, partner: "智远自动化", buyer: "周梓棋", owner: null, receiver: null, flags: [], sheet: "入库明细", rowNo: 5882, importId: 1, createdAt: "2026-11-09 15:01:00" },
  { id: 2, kind: "in", docDate: "2026-08-31", docNo: "20260831206", deliveryNo: "2026070475", itemCode: "WG-DQ-0554", itemName: "何服电机MS6L-100TH30B2-41P5", spec: null, unit: "台", qty: 9, priceMicros: 0, amountCents: 0, remark: null, partner: "智远自动化", buyer: "周梓棋", owner: null, receiver: null, flags: ["no_amount"], sheet: "入库明细", rowNo: 5883, importId: 1, createdAt: "2026-11-09 15:01:00" },
  { id: 3, kind: "in", docDate: "2026-08-31", docNo: "20260831206", deliveryNo: "2026070475", itemCode: "WG-DQ-0573", itemName: "步进电缆CP-MD-03", spec: null, unit: "条", qty: 10, priceMicros: 500000, amountCents: 50000, remark: null, partner: "智远自动化", buyer: "周梓棋", owner: null, receiver: null, flags: [], sheet: "入库明细", rowNo: 5884, importId: 1, createdAt: "2026-11-09 15:01:00" },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.exposeFunction("__docHits", () => hits);
await page.exposeFunction("__docLines", () => lines);

await page.addInitScript(() => {
  const ok = (v) => Promise.resolve(v);
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      window.__calls.push({ command, args });
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 4, dbPath: "x", rowCount: 7677, importCount: 1,
            minDate: "2025-04-12", maxDate: "2026-08-31", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "2026-11-10 08:00:00" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "voucher_list":
          return ok([]);
        case "voucher_next_no":
          return ok("20261110001");
        case "items_list":
          return ok([]);
        case "suppliers_list":
          return ok([]);
        case "doc_search":
          return window.__docHits().then((h) => h);
        case "doc_lines":
          return window.__docLines().then((l) => l);
        default:
          return ok(null);
      }
    },
  };
});

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1600);

// 输入编号并查询
const input = page.getByPlaceholder(/单据编号/);
await input.fill("0831");
await page.getByRole("button", { name: /^查询$/ }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: "shots/doc-search.png" });

const hitCount = await page.locator("section:has-text('单据查询') li").count();
const hitText = await page.locator("section:has-text('单据查询')").innerText();

// 点导入单据 → 只读明细弹窗
await page.locator("section:has-text('单据查询') li").first().click();
await page.waitForTimeout(900);
await page.screenshot({ path: "shots/doc-lines.png" });

const dialogText = await page.locator('[role="dialog"]').last().innerText().catch(() => "");

// 查表头与首行的实际几何，判断是叠字还是行高问题
const geom = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return null;
  const thead = dlg.querySelector("thead tr");
  const tbody = dlg.querySelector("tbody tr");
  const th = thead ? thead.querySelector("th") : null;
  const td = tbody ? tbody.querySelector("td") : null;
  const r = (el) => (el ? { h: Math.round(el.getBoundingClientRect().height), top: Math.round(el.getBoundingClientRect().top) } : null);
  return {
    thead: r(thead),
    tbody: r(tbody),
    th: r(th),
    td: r(td),
    tableH: dlg.querySelector("table")?.getBoundingClientRect().height,
  };
});
console.log("GEOM:", JSON.stringify(geom));
const calls = await page.evaluate(() => window.__calls.filter((c) => c.command.startsWith("doc_")));

console.log(
  JSON.stringify({ hitCount, hitText: hitText.slice(0, 400), dialogText: dialogText.slice(0, 500), calls, pageErrors }, null, 2),
);
await browser.close();
