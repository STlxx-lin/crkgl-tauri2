// 验收：台账「按单据合并」开关。默认逐行显示，开启后同一单据折成一行，并记住状态。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const make = () => {
  const rows = [];
  let id = 1;
  const push = (docNo, name, qty, amountCents) => {
    rows.push({
      id: id++, kind: "in", docDate: "2026-09-01", docNo,
      deliveryNo: "0023378", itemCode: `WG-${id}`, itemName: name, spec: null,
      unit: "个", qty, priceMicros: 15000, amountCents,
      partner: "万杨五金", buyer: "严兰兰", owner: null, receiver: null,
      remark: null, flags: [], rowNo: id,
    });
  };
  push("20260901001", "外卡（轴）φ10", 10, 1500);
  push("20260901001", "轴承 6204", 2, 300);
  push("20260901001", "钢丝扣 80", 5, 750);
  push("20260901002", "垫片 M8", 100, 15000);
  push("20260901002", "弹簧垫圈", 50, 7500);
  push(null, "无单号散货", 1, 150);
  return rows;
};

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  const data = window.__seed;
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: data.length, importCount: 1,
            minDate: "2026-09-01", maxDate: "2026-09-02", inRows: data.length, outRows: 0,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: ["万杨五金"], buyers: ["严兰兰"], minDate: "2026-09-01", maxDate: "2026-09-02", itemCount: 5, inRows: data.length, outRows: 0 });
        case "ledger_page":
          return ok({
            rows: data, total: data.length, page: 1, pageSize: 100,
            totals: { rows: data.length, inRows: data.length, outRows: 0, amountInCents: 25200, amountOutCents: 0, qtyIn: 168, qtyOut: 0, docCount: 2, itemCount: 5 },
          });
        case "suppliers_list":
        case "voucher_list":
        case "voucher_search":
        case "items_list":
        case "item_types":
        case "items_count":
          return ok([]);
        case "master_stats":
          return ok({ items: 0, itemsActive: 0, suppliers: 0, withDrawing: 0, missingDrawing: 0, itemTypes: [], categories: [] });
        case "voucher_next_no":
          return ok("20261110001");
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.log("ERR", String(e.stack ?? e).split(/\n/).slice(0, 4).join(" | "));
});
// 种子在 stub 之前注入（init script 里先注册的先执行），否则 stub 读不到 __seed
await page.addInitScript((rows) => { window.__seed = rows; }, make());
await page.addInitScript(stub);

const readTable = () =>
  page.evaluate(() => {
    const t = document.querySelector("table");
    if (!t) return [];
    return Array.from(t.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.children).map((td) => td.innerText.trim()),
    );
  });

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
console.log("NAV", JSON.stringify(await page.locator("nav button").allInnerTexts()));
console.log("BODY", (await page.evaluate(() => document.body.innerText)).slice(0, 300));
console.log("ERRS", JSON.stringify(errors));
await page.getByRole("button", { name: /^台账/ }).first().click();
await page.waitForTimeout(1200);

const offRows = await readTable();
await page.screenshot({ path: "shots/merge-off.png" });

const toggle = page.getByRole("button", { name: /按单据合并/ });
await toggle.click();
await page.waitForTimeout(600);
const onRows = await readTable();
const onFooter = await page.evaluate(() => Array.from(document.querySelectorAll("p")).map((p) => p.innerText).find((t) => t.includes("合并自")) ?? "");
const disabledChecks = await page.evaluate(() =>
  Array.from(document.querySelectorAll("tbody input[type=checkbox]")).map((el) => el.disabled),
);
await page.screenshot({ path: "shots/merge-on.png" });

// 刷新后应保持开启
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /^台账/ }).first().click();
await page.waitForTimeout(1200);
const afterReload = await readTable();

// 再点一次关闭
await page.getByRole("button", { name: /按单据合并/ }).click();
await page.waitForTimeout(500);
const backOff = await readTable();

console.log(
  JSON.stringify(
    {
      offRowCount: offRows.length,
      offDocColumn: offRows.map((r) => r[3]),
      onRowCount: onRows.length,
      onRows: onRows.map((r) => ({ doc: r[3], item: r[5], unit: r[6], qty: r[7], amount: r[9] })),
      disabledChecks,
      onFooter,
      afterReloadRowCount: afterReload.length,
      backOffRowCount: backOff.length,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
