// 台账多选 + 批量改/删的验收：桩桥 + 真实页面。
import { chromium } from "playwright";

function makeStub() {
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push({
      id: 100 + i,
      kind: i % 2 === 0 ? "in" : "out",
      docDate: "2026-08-31",
      docNo: "2026083120" + i,
      deliveryNo: null,
      itemCode: "WG-T-" + i,
      itemName: "测试物料 " + i,
      spec: null,
      unit: "个",
      qty: 2 + i,
      priceCents: 100,
      amountCents: (2 + i) * 100,
      remark: null,
      partner: "万杨五金",
      buyer: null,
      owner: null,
      receiver: null,
      flags: [],
      sheet: "voucher:in",
      rowNo: i + 1,
      importId: null,
      createdAt: "2026-11-09 21:00:00",
    });
  }
  const totals = {
    rows: 8, inRows: 4, outRows: 4,
    amountInCents: 1200, amountOutCents: 1600,
    qtyIn: 20, qtyOut: 28, docCount: 8, itemCount: 8,
  };
  return { rows, totals };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

const { rows, totals } = makeStub();
await page.exposeFunction("__stubData", () => ({ rows, totals }));
await page.addInitScript(() => {
  const ok = (v) => Promise.resolve(v);
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      window.__calls.push({ command, args });
      const data = window.__stubDataSync;
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 2, dbPath: "x", rowCount: 8, importCount: 0,
            minDate: "2026-08-31", maxDate: "2026-08-31", inRows: 4, outRows: 4,
            web: { enabled: true, listening: false, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: null },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "ledger_page":
          return window.__stubData().then((d) => ok({ rows: d.rows, total: d.rows.length, page: 1, pageSize: 100, totals: d.totals }));
        case "ledger_bulk_update":
          return ok((((args || {}).args || {}).ids || []).length);
        case "ledger_bulk_delete":
          return ok(((args || {}).ids || []).length);
        default:
          return ok(null);
      }
    },
  };
});

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1800);

const state = await page.evaluate(() => ({
  rows: document.querySelectorAll("tbody tr").length,
  headerKeys: Array.from(document.querySelectorAll("thead th")).map((t) => t.getAttribute("data-key")),
  checkboxes: document.querySelectorAll('[role="checkbox"], input[type="checkbox"]').length,
}));

console.log("STATE:", JSON.stringify(state));
console.log("PAGE ERRORS:", JSON.stringify(pageErrors.slice(0, 3)));
console.log("CONSOLE ERRORS:", JSON.stringify(consoleErrors.slice(0, 3)));
await page.screenshot({ path: "shots/v-bulk-initial.png" });

// 全选本页
await page.locator('thead input[type="checkbox"]').click();
await page.waitForTimeout(400);
const barText = await page.locator("text=/已选 \d+ 行/").first().innerText().catch(() => "(none)");
await page.screenshot({ path: "shots/v-bulk-selected.png" });

// 批量改归属
await page.getByRole("button", { name: /批量改/ }).click();
await page.waitForTimeout(500);
const dialog = page.locator('[role="dialog"]').last();
await dialog.locator("input").first().fill("批量归属");
await page.screenshot({ path: "shots/v-bulk-dialog.png" });
await dialog.getByRole("button", { name: /^应用$/ }).click();
await page.waitForTimeout(900);
const bulkUpdate = await page.evaluate(() => window.__calls.find((c) => c.command === "ledger_bulk_update") || null);

// 再全选并批量删
await page.locator('thead input[type="checkbox"]').click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: /批量删除/ }).click();
await page.waitForTimeout(600);
await page.locator('[role="alertdialog"]').getByRole("button", { name: /^删除$/ }).click();
await page.waitForTimeout(900);
const bulkDelete = await page.evaluate(() => window.__calls.find((c) => c.command === "ledger_bulk_delete") || null);

console.log("BAR:", barText);
console.log("BULK UPDATE:", JSON.stringify(bulkUpdate));
console.log("BULK DELETE:", JSON.stringify(bulkDelete));
await browser.close();
