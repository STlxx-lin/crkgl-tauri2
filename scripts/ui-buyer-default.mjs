// 验收：采购人默认值 = 上一次保存的值。只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  window.__savedInputs = [];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 6, importCount: 1,
            minDate: "2026-09-01", maxDate: "2026-09-02", inRows: 6, outRows: 0,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "voucher_create":
          window.__savedInputs.push(args?.args ?? args);
          return ok(99);
        case "voucher_next_no":
          return ok("20261110001");
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "suppliers_list":
        case "voucher_list":
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
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);

const buyerInput = () => page.getByLabel("采购人");

const firstDefault = await buyerInput().inputValue();

// 改成另一个人并保存
await buyerInput().fill("张三");
await page.locator("tbody tr").first().locator("input").nth(1).fill("WG-A-001");
await page.waitForTimeout(400);
await page.getByRole("button", { name: /保存单据|保存修改/ }).click();
await page.waitForTimeout(900);
const savedPayload = await page.evaluate(() => window.__savedInputs.at(-1) ?? null);

// 新建下一张：默认值应是张三
await page.getByRole("button", { name: /新入库单/ }).click();
await page.waitForTimeout(800);
const afterSave = await buyerInput().inputValue();

// 刷新：仍是张三
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(800);
const afterReload = await buyerInput().inputValue();

// 出库单不带采购人
await page.getByRole("button", { name: /新出库单/ }).click();
await page.waitForTimeout(600);
const outBuyer = (await page.getByLabel("采购人").count()) ? await page.getByLabel("采购人").inputValue() : "(出库无采购人)";

console.log(
  JSON.stringify(
    {
      firstDefault,
      savedPayloadBuyer: savedPayload?.buyer ?? savedPayload?.args?.buyer ?? null,
      afterSave,
      afterReload,
      outBuyer,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
