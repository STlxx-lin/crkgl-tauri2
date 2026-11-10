// 验收：保存成功后自动打开 A4 打印视图；保存失败不打印。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  window.__failSave = false;
  const fresh = {
    id: 77, kind: "in", docNo: "20261111001", docDate: "2026-11-11",
    partner: "万杨五金", deliveryNo: null, buyer: "测试", owner: null, receiver: null,
    remark: null, rowCount: 1, amountCents: 4200, createdAt: "x", sheet: "voucher:in",
    lines: [{ id: 1, ledgerId: 1, deliveryNo: "D001", itemCode: "WG-A", itemName: "外卡（轴）φ10",
      unit: "个", qty: 10, priceMicros: 420000, amountCents: 4200, remark: null }],
  };
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 7678, importCount: 1,
            minDate: "2025-04-12", maxDate: "2026-11-10", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "voucher_create":
          if (window.__failSave) return Promise.reject("模拟保存失败");
          return ok(77);
        case "voucher_get":
          return ok(fresh);
        case "voucher_list":
          return ok([]);
        case "voucher_next_no":
          return ok("20261111001");
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
const page = await browser.newPage({ viewport: { width: 1463, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

const drive = async (fail) => {
  await page.evaluate((f) => { window.__failSave = f; }, fail);
  await page.goto(process.env.BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  await page.getByRole("button", { name: /开单/ }).first().click();
  await page.waitForTimeout(800);
  // 入库单第 1 个 input 是送货单号，第 2 个是物料编码；按 placeholder 更稳
  await page.locator('input[placeholder="送货单号"]').first().fill("D001");
  await page.locator('input[placeholder="编码或名称"]').first().fill("WG-A");
  await page.waitForTimeout(300);
  await page.locator('input[placeholder="物料名称"]').first().fill("外卡（轴）φ10");
  await page.locator('input[placeholder="单位"]').first().fill("个");
  await page.locator('input[placeholder="0"]').first().fill("10");
  await page.locator('input[placeholder="0.00"]').first().fill("42");
  await page.waitForTimeout(400);
  console.log("SAVE_BTN", await page.getByRole("button", { name: /保存/ }).allInnerTexts());
  await page.getByRole("button", { name: /保存/ }).first().click();
  await page.waitForTimeout(1600);
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log("TOASTS", bodyText.slice(0, 300).split("\n").join(" | "));
  return page.evaluate(() => {
    const overlay = document.querySelector(".print-overlay");
    const papers = overlay ? overlay.querySelectorAll(".print-paper").length : 0;
    const text = overlay ? overlay.innerText.slice(0, 200) : "";
    return { printOpened: Boolean(overlay), papers, hasDocNo: /20261111001/.test(text) };
  });
};

const success = await drive(false);
await page.screenshot({ path: "shots/save-then-print.png" });
const failure = await drive(true);

console.log(JSON.stringify({ success, failure, errors }, null, 2));
await browser.close();
