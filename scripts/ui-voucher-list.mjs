// 验收：本机开单列表——点行只开详情不冲表单，载入编辑才灌入，筛选与合计正确。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  const vouchers = [
    { id: 1, kind: "in", docNo: "20260901001", docDate: "2026-09-01", partner: "万杨五金", owner: null, rowCount: 2, amountCents: 4500, createdAt: "x", firstItem: "外卡" },
    { id: 2, kind: "in", docNo: "20260901002", docDate: "2026-09-01", partner: "台邦电机", owner: null, rowCount: 1, amountCents: 12000, createdAt: "x", firstItem: "电机" },
    { id: 3, kind: "out", docNo: "20260902001", docDate: "2026-09-02", partner: null, owner: null, rowCount: 3, amountCents: 800, createdAt: "x", firstItem: "外卡（轴）φ10" },
  ];
  const lineOf = (id, code, name, qty, price) => ({
    id, ledgerId: id, deliveryNo: "D001", itemCode: code, itemName: name, unit: "个",
    qty, priceMicros: price, amountCents: Math.round((qty * price) / 100), remark: null,
  });
  const detail = {
    1: { id: 1, kind: "in", docNo: "20260901001", docDate: "2026-09-01", partner: "万杨五金", deliveryNo: "D001", buyer: "严兰兰", owner: null, receiver: null, remark: null, rowCount: 2, amountCents: 4500, createdAt: "x", sheet: "voucher:in",
      lines: [lineOf(11, "WG-A", "外卡", 10, 15000), lineOf(12, "WG-B", "轴承", 2, 100000)] },
    2: { id: 2, kind: "in", docNo: "20260901002", docDate: "2026-09-01", partner: "台邦电机", deliveryNo: "D002", buyer: "严兰兰", owner: null, receiver: null, remark: null, rowCount: 1, amountCents: 12000, createdAt: "x", sheet: "voucher:in",
      lines: [lineOf(21, "WG-C", "电机", 1, 120000)] },
    3: { id: 3, kind: "out", docNo: "20260902001", docDate: "2026-09-02", partner: null, deliveryNo: null, buyer: null, owner: "乾力车间", receiver: "李四", remark: null, rowCount: 3, amountCents: 800, createdAt: "x", sheet: "voucher:out",
      lines: [lineOf(31, "WG-A", "外卡", 1, 15000)] },
  };
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 7677, importCount: 1,
            minDate: "2025-10-30", maxDate: "2026-08-31", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "voucher_list":
          return ok(vouchers);
        case "voucher_get":
          return ok(detail[args?.id ?? args?.args?.id] ?? null);
        case "voucher_next_no":
          return ok("20261110001");
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(1000);

// 先在左边录点东西，验证点列表不会冲掉
await page.locator("tbody tr").first().locator("input").nth(1).fill("录入中-未保存");
await page.waitForTimeout(400);

const before = await page.locator("tbody tr").first().locator("input").nth(1).inputValue();

// 点第一张单据 -> 应该只弹详情
await page.getByRole("button", { name: /20260901001/ }).first().click();
await page.waitForTimeout(800);
const dialogOpen = await page.locator('[role="dialog"]').count();
const dialogText = dialogOpen ? await page.locator('[role="dialog"]').last().innerText() : "";
await page.screenshot({ path: "shots/voucher-detail.png" });

// 关闭，表单内容应保持
await page.locator('[role="dialog"]').last().getByRole("button", { name: /^关闭$/ }).click();
await page.waitForTimeout(400);
const afterClose = await page.locator("tbody tr").first().locator("input").nth(1).inputValue();

// 筛选：只看入库
await page.getByRole("button", { name: "入库", exact: true }).last().click();
await page.waitForTimeout(400);
const listAfterFilter = await page.evaluate(() => document.body.innerText.match(/入库 \d+ 张 · 出库 \d+ 张/)?.[0] ?? "");

// 搜索供应商
await page.getByLabel("筛选本机单据").fill("台邦");
await page.waitForTimeout(400);
const listAfterSearch = await page.evaluate(() => document.body.innerText.match(/\d+ \/ \d+ 张/)?.[0] ?? "");

// 清空筛选，检查没有供应商那行显示的是物料名而不是「—」
await page.getByLabel("筛选本机单据").fill("");
await page.getByRole("button", { name: "全部", exact: true }).last().click();
await page.waitForTimeout(400);
const thirdRow = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll("li button")).filter((b) => b.innerText.includes("20260902001"));
  return rows[0]?.innerText.split("\n").join(" | ") ?? null;
});
await page.screenshot({ path: "shots/voucher-list-info.png", fullPage: false });

console.log(JSON.stringify({
  formBeforeClick: before,
  dialogOpen,
  dialogHasLineTable: /送货单号/.test(dialogText) && /外卡/.test(dialogText),
  dialogHasLoadButton: /载入编辑/.test(dialogText),
  formAfterClose: afterClose,
  filterConsistent: before === afterClose,
  listAfterFilter,
  listAfterSearch,
  thirdRow,
  errors,
}, null, 2));
await browser.close();
