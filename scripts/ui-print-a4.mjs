// 验收：台账单据编号合并显示 + A4 打印视图（默认 8 行、可分页、设置可改行数）。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const ledgerRows = [];
let id = 1;
const push = (docNo, name, qty) => {
  ledgerRows.push({
    id: id++,
    kind: "in",
    docDate: "2026-09-01",
    docNo,
    deliveryNo: "0023378",
    itemCode: `WG-${id}`,
    itemName: name,
    spec: null,
    unit: "个",
    qty,
    priceMicros: 15000,
    amountCents: Math.round(qty * 150),
    partner: "万杨五金",
    owner: null,
    buyer: "严兰兰",
    receiver: null,
    remark: null,
    flags: [],
    rowNo: id,
  });
};
push("20260901001", "外卡（轴）φ10", 10);
push("20260901001", "轴承 6204", 2);
push("20260901001", "钢丝扣 80", 5);
push("20260901002", "垫片 M8", 100);
push("20260901002", "弹簧垫圈", 50);
push(null, "无单号散货", 1);

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  window.__calls = [];
  const items = [
    { itemCode: "WG-A-001", itemName: "外卡（轴）φ10", unit: "个", lastPriceCents: 3, hits: 300 },
    { itemCode: "WG-B-002", itemName: "轴承 6204", unit: "只", lastPriceCents: 1050, hits: 88 },
  ];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      window.__calls.push({ command, args });
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 6, importCount: 1,
            minDate: "2026-09-01", maxDate: "2026-09-02", inRows: 5, outRows: 1,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "2026-11-10 10:00:00" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: "2026-09-01", maxDate: "2026-09-02", itemCount: 5, inRows: 5, outRows: 1 });
        case "ledger_page":
          return ok({ rows: window.__rows, total: window.__rows.length, page: 1, pageSize: 50, sumQtyIn: 168, sumQtyOut: 0, sumAmountIn: 25200, sumAmountOut: 0 });
        case "web_access_log":
          return ok([]);
        case "web_status":
          return ok({ enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: ["http://127.0.0.1/"], staticReady: true, startedAt: "2026-11-10 10:00:00" });
        case "voucher_list":
        case "voucher_search":
          return ok([]);
        case "voucher_next_no":
          return ok("20261110001");
        case "items_list":
          return ok(items.map((i, idx) => ({
            id: idx + 1, itemCode: i.itemCode, itemName: i.itemName, category: null, unit: i.unit,
            priceMicros: i.lastPriceCents * 10_000, spec: null, itemType: null, drawingNo: null,
            owner: null, supplier: null, remark: null, active: true,
          })));
        default:
          return ok(null);
      }
    },
  };
  window.__rows = [];
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.log("ERR", String(e.stack).split("\n").slice(0, 4).join(" | "));
});
await page.addInitScript(stub);
await page.addInitScript((rows) => {
  window.__rows = rows;
}, ledgerRows);

const BASE = process.env.BASE ?? "http://localhost:1422/";
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);

// 1) 台账：单据编号合并
await page.getByRole("button", { name: /台账/ }).first().click();
await page.waitForTimeout(1200);
const docCells = await page.evaluate(() => {
  const table = document.querySelector("table");
  if (!table) return [];
  return Array.from(table.querySelectorAll("tbody tr")).map((tr) => tr.children[3]?.innerText.trim() ?? "");
});
await page.screenshot({ path: "shots/ledger-merged-doc.png" });

// 2) 开单 -> A4 打印
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);
await page.getByLabel("第 1 行送货单号").fill("0023378");
await page.locator("tbody tr").first().locator("input").nth(1).fill("WG-A-001");
await page.waitForTimeout(400);
await page.getByRole("button", { name: /加一行/ }).click();
await page.waitForTimeout(300);
await page.getByLabel("第 2 行送货单号").fill("0023401");
await page.locator("tbody tr").nth(1).locator("input").nth(1).fill("WG-B-002");
await page.waitForTimeout(500);

await page.getByRole("button", { name: /A4 打印/ }).click();
await page.waitForTimeout(900);
const printInfo = await page.evaluate(() => {
  const overlay = document.querySelector(".print-overlay");
  if (!overlay) return null;
  const papers = Array.from(overlay.querySelectorAll(".print-paper"));
  return {
    papers: papers.length,
    firstRows: papers[0]?.querySelectorAll(".print-table tbody tr").length ?? 0,
    dataRows: Array.from(papers[0]?.querySelectorAll(".print-table tbody tr") ?? []).filter((tr) => !tr.hasAttribute("aria-hidden")).length,
    blankRows: Array.from(papers[0]?.querySelectorAll(".print-table tbody tr[aria-hidden]") ?? []).length,
    title: papers[0]?.querySelector(".print-title")?.innerText ?? "",
    meta: papers[0]?.querySelector(".print-meta")?.innerText.replace(/\n/g, " | ") ?? "",
    headers: Array.from(papers[0]?.querySelectorAll(".print-table thead th") ?? []).map((th) => th.innerText),
  };
});
await page.screenshot({ path: "shots/print-a4.png", fullPage: false });

// 3) 设置里改行数
await page.getByRole("button", { name: /关闭/ }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /只读站/ }).first().click();
await page.waitForTimeout(2000);
const rowInput = page.getByLabel("A4 每页明细行数");
const beforeSetting = await rowInput.inputValue();
await rowInput.fill("10");
await rowInput.blur();
await page.waitForTimeout(400);
await page.screenshot({ path: "shots/print-setting.png" });

await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: /A4 打印/ }).click();
await page.waitForTimeout(700);
const afterSetting = await page.evaluate(() => {
  const paper = document.querySelector(".print-paper");
  return {
    rows: paper?.querySelectorAll(".print-table tbody tr").length ?? 0,
    hint: document.querySelector(".print-overlay span")?.innerText ?? "",
  };
});

console.log(JSON.stringify({ docCells, printInfo, beforeSetting, afterSetting, errors }, null, 2));
await browser.close();
