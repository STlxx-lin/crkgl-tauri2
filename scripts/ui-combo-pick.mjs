// 复现：供应商 ComboBox 选中后，输入框是否显示选中值。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.addInitScript(() => {
  const ok = (v) => Promise.resolve(v);
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      window.__calls.push({ command, args });
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 7677, importCount: 1,
            minDate: "2025-04-12", maxDate: "2026-08-31", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "2026-11-10 09:00:00" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "voucher_list":
          return ok([]);
        case "voucher_next_no":
          return ok("20261110001");
        case "items_list":
          return ok([
            { id: 1, itemCode: "WG-A", itemName: "外卡", category: "五金类", unit: "个", priceMicros: 15000, spec: null, itemType: "外购件", drawingNo: null, owner: null, supplier: null, remark: null, active: true },
          ]);
        case "suppliers_list":
          return ok([
            { id: 1, name: "万杨五金", contact: null, phone: null, remark: null, active: true, hits: 904 },
            { id: 2, name: "鼎铭自动化", contact: null, phone: null, remark: null, active: true, hits: 754 },
            { id: 3, name: "严兰兰", contact: null, phone: null, remark: null, active: true, hits: 735 },
          ]);
        default:
          return ok(null);
      }
    },
  };
});

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1800);

const supplier = page.locator('[aria-label="供应商"]').first();
const before = await supplier.inputValue().catch(() => "(no value)");

// 打开并选一条
await supplier.click();
await page.waitForTimeout(600);
const optCount = await page.locator('[role="option"]').count();
console.log("OPTIONS:", optCount);
await page.locator('[role="option"]').filter({ hasText: "万杨五金" }).first().click();
await page.waitForTimeout(900);
const stateAfter = await page.evaluate(() => {
  const el = document.querySelector('[aria-label="供应商"]');
  return { v: el?.value, exp: el?.getAttribute("aria-expanded") };
});
console.log("AFTER CLICK DOM:", JSON.stringify(stateAfter));
// 试试手动输入能否改变 DOM（判断是不是只读/受控失效）
await supplier.fill("测试输入");
await page.waitForTimeout(400);
const typed = await supplier.inputValue().catch(() => "(err)");
console.log("TYPED VALUE:", typed);

const afterClick = await supplier.inputValue().catch(() => "(no value)");
await page.screenshot({ path: "shots/combo-pick.png" });

// 再点「保存单据」看载荷里的 partner
await page.getByRole("button", { name: /保存单据/ }).click().catch(() => {});
await page.waitForTimeout(800);
const call = await page.evaluate(() => window.__calls.find((c) => c.command === "voucher_create") || null);

// 直接看 DOM：选中后 input 的 value 与 aria 状态
const dom = await page.evaluate(() => {
  const el = document.querySelector('[aria-label="供应商"]');
  return el ? { tag: el.tagName, value: el.value, expanded: el.getAttribute("aria-expanded"), role: el.getAttribute("role") } : null;
});
console.log(JSON.stringify({ before, afterClick, dom, payloadPartner: call?.args?.args?.partner ?? null, errors }, null, 2));
await browser.close();
