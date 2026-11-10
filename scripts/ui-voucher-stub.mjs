// 用桩 Tauri 桥在浏览器里跑开单页：验证输入、物料联动、保存时发出的载荷。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (value) => Promise.resolve(value);
  window.__calls = [];
  const items = [
    { itemCode: "WG-WJ-0716", itemName: "80 钢丝扣", unit: "只", lastPriceCents: 400, hits: 12 },
    { itemCode: "WG-A-001", itemName: "外卡（轴）φ10", unit: "个", lastPriceCents: 3, hits: 300 },
    { itemCode: "WG-B-002", itemName: "轴承 6204", unit: "只", lastPriceCents: 1050, hits: 88 },
  ];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      window.__calls.push({ command, args });
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0",
            schemaVersion: 2,
            dbPath: "C:\\tmp\\ledger.db",
            rowCount: 7677,
            importCount: 1,
            minDate: "2025-04-12",
            maxDate: "2026-08-31",
            inRows: 5887,
            outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: ["http://127.0.0.1:80/"], staticReady: true, startedAt: "2026-11-09 21:00:00" },
            startupImport: null,
            lastError: null,
            sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "voucher_list":
          return ok([]);
        case "items_list":
          return ok(items.map((i, idx) => ({
            id: idx + 1,
            itemCode: i.itemCode,
            itemName: i.itemName,
            category: "五金类",
            unit: i.unit,
            priceCents: i.lastPriceCents,
            spec: null,
            owner: null,
            supplier: null,
            remark: null,
            active: true,
          })));
        case "suppliers_list":
          return ok([
            { id: 1, name: "万杨五金", contact: null, phone: null, remark: null, active: true, hits: 904 },
            { id: 2, name: "鼎铭自动化", contact: null, phone: null, remark: null, active: true, hits: 754 },
          ]);
        case "voucher_next_no":
          return ok("20261109001");
        case "voucher_create":
          return ok(7);
        case "voucher_update":
          return ok(null);
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);

// 第一行：填物料编码，应自动带出名称/单位/单价
const codeInput = page.locator('input[list="item-codes"]').first();
await codeInput.fill("WG-WJ-0716");
await page.waitForTimeout(500);

const afterPick = await page.evaluate(() => {
  const row = document.querySelector('input[list="item-codes"]')?.closest("tr");
  if (!row) return null;
  const inputs = Array.from(row.querySelectorAll("input")).map((i) => i.value);
  return { values: inputs, rowText: row.innerText };
});

// 数量
const row = page.locator("tbody tr").first();
const inputs = row.locator("input");
await inputs.nth(3).fill("3");
await page.waitForTimeout(300);

// 表头供应商
await page.locator("label", { hasText: "供应商" }).locator("input").first().fill("万杨五金");
await page.waitForTimeout(300);

const filled = await page.evaluate(() => {
  const tr = document.querySelector('input[list="item-codes"]')?.closest("tr");
  const inputs = tr ? Array.from(tr.querySelectorAll("input")).map((i) => i.value) : [];
  return { inputs, footerText: tr?.closest("table")?.querySelector("tfoot")?.innerText ?? "" };
});
await page.screenshot({ path: "shots/v-stub-filled.png" });

// 保存
await page.getByRole("button", { name: /保存单据/ }).click();
await page.waitForTimeout(900);

const createCall = await page.evaluate(() => window.__calls.find((c) => c.command === "voucher_create") ?? null);

console.log(JSON.stringify({ afterPick, filled, createCall, errors }, null, 2));
await browser.close();
