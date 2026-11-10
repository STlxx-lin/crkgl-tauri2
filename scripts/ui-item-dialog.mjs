// 验证「新增物料」弹窗：图号与类型字段存在，且保存载荷带上它们。
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 });
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
        case "master_stats":
          return ok({
            items: 4390, itemsActive: 4390, suppliers: 162,
            itemTypes: [{ category: "外购件", count: 631 }, { category: "加工件", count: 244 }, { category: "未分类", count: 3515 }],
            categories: [{ category: "原材料", count: 1317 }, { category: "五金类", count: 727 }],
          });
        case "items_list":
          return ok([]);
        case "items_count":
          return ok(0);
        case "suppliers_list":
          return ok([]);
        case "voucher_list":
          return ok([]);
        case "voucher_next_no":
          return ok("20261110002");
        case "item_create":
          return ok(99);
        default:
          return ok(null);
      }
    },
  };
});

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1600);
await page.getByRole("button", { name: /基础资料/ }).first().click();
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /新增物料/ }).first().click();
await page.waitForTimeout(900);

const dialog = page.locator('[role="dialog"]').last();
const labels = await dialog.innerText();
await page.screenshot({ path: "shots/item-dialog.png" });

// 填必填 + 图号
const inputs = dialog.locator("input");
await inputs.nth(0).fill("WG-TEST-9001");   // 物料编码
await inputs.nth(1).fill("个");              // 单位
await inputs.nth(2).fill("测试加工件");        // 物料名称
// 图号是第 3 个输入框
await inputs.nth(3).fill("QLKJ480-002.065");
await page.waitForTimeout(300);
await page.screenshot({ path: "shots/item-dialog-filled.png" });

// 选类型：按 aria-label 定位下拉
const typeSelect = dialog.locator('[aria-label="物料类型"]').first();
await typeSelect.click();
await page.waitForTimeout(500);
await page.locator('[role="option"]').filter({ hasText: "加工件" }).first().click();
await page.waitForTimeout(400);

console.log("DIALOG:", labels.slice(0, 400));
await dialog.getByRole("button", { name: /^保存$/ }).click();
await page.waitForTimeout(900);

const createCall = await page.evaluate(() => window.__calls.find((c) => c.command === "item_create") || null);
console.log(JSON.stringify({ hasDrawingLabel: labels.includes("图号"), hasTypeLabel: labels.includes("类型"), createCall, errors }, null, 2));
await browser.close();
