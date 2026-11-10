// 验收：导入向导把供应商 / 物料编号 / 基础信息认成基础资料表，并与明细表分开显示。
// 桩掉 dialog 插件返回固定路径、inspect 返回真实结构，走完整按钮流程。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const sheet = (name, rows, detail, master, note) => ({
  name, rows, nonEmptyRows: rows, detail, master, note, headers: [], sample: [],
});

const report = {
  path: "E:\\x\\仓库出入库明细_5611_Modified.xlsm",
  fileName: "仓库出入库明细_5611_Modified.xlsm",
  sizeBytes: 1237976,
  sheets: [
    sheet("供应商名称", 161, false, true, "供应商表：160 行，写入基础资料"),
    sheet("基础信息", 3786, false, true, "基础信息表：3785 行，写入基础资料"),
    sheet("入库单", 2716, false, false, "不像明细表（缺日期/数量/物料列），不会导入"),
    sheet("入库明细", 5888, true, false, "明细表：5887 行数据"),
    sheet("出库单", 2721, false, false, "不像明细表（缺日期/数量/物料列），不会导入"),
    sheet("出库明细", 1791, true, false, "明细表：1790 行数据"),
    sheet("库存明细", 2886, false, false, "不像明细表（缺日期/数量/物料列），不会导入"),
    sheet("物料编号", 3856, false, true, "物料表：3855 行，写入基础资料"),
    sheet("Sheet1", 0, false, false, "空表"),
  ],
};

const stub = () => {
  const ok = (v) => Promise.resolve(v);
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
        case "plugin:dialog|open":
        case "dialog_open":
          return ok(window.__picked);
        case "import_inspect":
          return ok(window.__report);
        case "import_history":
          return ok([]);
        case "suppliers_list":
        case "voucher_list":
        case "voucher_search":
        case "items_list":
          return ok([]);
        case "voucher_next_no":
          return ok("20261110001");
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript((r) => { window.__report = r; window.__picked = r.path; }, report);
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1600);
console.log("ERRS", JSON.stringify(errors));
console.log("BODY", (await page.evaluate(() => document.body.innerText)).slice(0, 200));
await page.getByRole("button", { name: /^导入/ }).first().click();
await page.waitForTimeout(900);

await page.getByRole("button", { name: /选择文件/ }).first().click();
await page.waitForTimeout(1500);

const view = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    hasMasterSection: text.includes("基础资料"),
    hasSupplier: /供应商名称\s*160 行/.test(text.replace(/\s+/g, " ")),
    hasMaterial: text.includes("物料编号"),
    hasBase: text.includes("基础信息"),
    detailCards: Array.from(document.querySelectorAll("div")).filter((d) => /明细表：\d+ 行数据/.test(d.textContent ?? "")).length,
    summary: (text.match(/\d+ 张表[^\n]*/) ?? [""])[0],
  };
});
await page.screenshot({ path: "shots/import-master.png", fullPage: false });
console.log(JSON.stringify({ view, errors }, null, 2));
await browser.close();
