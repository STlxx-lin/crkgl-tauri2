// 验收：送货单号改为逐行填，单头标注已删除。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (value) => Promise.resolve(value);
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
            appVersion: "0.1.0",
            schemaVersion: 7,
            dbPath: "C:\\tmp\\ledger.db",
            rowCount: 7677,
            importCount: 1,
            minDate: "2025-04-12",
            maxDate: "2026-08-31",
            inRows: 5887,
            outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "2026-11-10 10:00:00" },
            startupImport: null,
            lastError: null,
            sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: ["乾力车间"], partners: ["万杨五金"], buyers: ["严兰兰"], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "voucher_list":
        case "voucher_search":
          return ok([]);
        case "items_list":
          return ok(items.map((i, idx) => ({
            id: idx + 1,
            itemCode: i.itemCode,
            itemName: i.itemName,
            category: null,
            unit: i.unit,
            priceMicros: i.lastPriceCents * 10_000,
            spec: null,
            itemType: null,
            drawingNo: null,
            owner: null,
            supplier: null,
            remark: null,
            active: true,
          })));
        case "items_count":
          return ok(items.length);
        case "voucher_next_no":
          return ok("20261110001");
        case "voucher_create":
          return ok(99);
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE ?? "http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(1000);

// 单头：不应再有「送货单号」标签
const headText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
// 单头横带（明细表之前的区域）里不应再有「送货单号」
const headBand = await page.evaluate(() => {
  const section = document.querySelector("section");
  if (!section) return "";
  const table = section.querySelector("table");
  const clone = section.cloneNode(true);
  const t = clone.querySelector("table");
  if (t) t.remove();
  return clone.innerText;
});
const headHasDelivery = /送货单号/.test(headBand);

// 表头：应有「送货单号」列
const headers = await page.locator("thead th").allInnerTexts();

// 第一行填送货单号 + 物料
await page.getByLabel("第 1 行送货单号").fill("0023378");
await page.locator("tbody tr").first().locator("input").nth(1).fill("WG-A-001");
await page.waitForTimeout(500);

// 第二行填另一个送货单号（同一张单多张送货单）
await page.getByRole("button", { name: /加一行/ }).click();
await page.waitForTimeout(400);
await page.getByLabel("第 2 行送货单号").fill("0023401");
await page.locator("tbody tr").nth(1).locator("input").nth(1).fill("WG-B-002");
await page.waitForTimeout(500);

const qty1 = page.locator("tbody tr").first().locator("input");
await qty1.nth(3).fill("10");
await page.waitForTimeout(200);

await page.screenshot({ path: "shots/v-delivery-lines.png" });

await page.getByRole("button", { name: /保存单据/ }).click();
await page.waitForTimeout(900);

const createCall = await page.evaluate(() => window.__calls.find((c) => c.command === "voucher_create") ?? null);
const raw = createCall?.args ?? null;
const input = raw?.input ?? raw?.args ?? raw?.voucher ?? raw;
const lines = input?.lines ?? null;

console.log(JSON.stringify({
  headBand,
  headHasDeliveryLabel: headHasDelivery,
  headers,
  payloadDelivery: (lines ?? []).map((l) => ({ deliveryNo: l.deliveryNo, itemCode: l.itemCode })),
  errors,
}, null, 2));
await browser.close();
