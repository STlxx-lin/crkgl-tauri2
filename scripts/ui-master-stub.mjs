// 基础资料页验收：桩桥 + 真实页面，验证物料/供应商列表、搜索、新增载荷。
import { chromium } from "playwright";

const items = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  itemCode: `WG-ZCL-${String(i + 1).padStart(4, "0")}`,
  itemName: ["51101", "51102", "外卡（轴）φ10", "轴承 6204", "电机 MS6L"][i % 5] + (i > 4 ? `-${i}` : ""),
  category: ["轴承类", "五金类", "电器类", "原材料"][i % 4],
  unit: ["只", "个", "台", "斤"][i % 4],
  priceCents: [150, 300, 1050, 220000][i % 4],
  spec: null,
  owner: null,
  supplier: i % 3 === 0 ? "万杨五金" : null,
  remark: null,
  active: i % 7 !== 0,
  itemType: i % 3 === 0 ? "外购件" : i % 3 === 1 ? "加工件" : null,
  drawingNo: i % 4 === 0 ? `QLKJ480-00${i}` : null,
}));

const suppliers = [
  { id: 1, name: "万杨五金", contact: "王师傅", phone: "13800000001", remark: null, active: true, hits: 904 },
  { id: 2, name: "鼎铭自动化", contact: null, phone: null, remark: null, active: true, hits: 754 },
  { id: 3, name: "智远自动化", contact: "李", phone: "13800000003", remark: null, active: true, hits: 270 },
  { id: 4, name: "停用供应商", contact: null, phone: null, remark: "不再合作", active: false, hits: 0 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
const consoleMsgs = [];
page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`.slice(0, 200)));
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.exposeFunction("__items", (opts) => {
  const kw = (opts.keyword ?? "").trim();
  let list = items;
  if (kw) list = list.filter((i) => i.itemCode.includes(kw) || i.itemName.includes(kw));
  if (opts.category) list = list.filter((i) => i.category === opts.category);
  if (opts.onlyActive) list = list.filter((i) => i.active);
  if (opts.itemType) list = list.filter((i) => i.itemType === opts.itemType);
  return { total: list.length, rows: list.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 100)) };
});

await page.addInitScript(() => {
  const ok = (v) => Promise.resolve(v);
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      window.__calls.push({ command, args });
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 3, dbPath: "x", rowCount: 7677, importCount: 1,
            minDate: "2025-04-12", maxDate: "2026-08-31", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: ["http://127.0.0.1:80/"], staticReady: true, startedAt: "2026-11-09 22:00:00" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "master_stats":
          return ok({
            items: 3856, itemsActive: 3800, suppliers: 162,
            itemTypes: [
              { category: "外购件", count: 631 },
              { category: "加工件", count: 244 },
              { category: "未分类", count: 3517 },
            ],
            categories: [
              { category: "原材料", count: 1318 },
              { category: "五金类", count: 727 },
              { category: "电器类", count: 650 },
              { category: "螺丝标准件", count: 351 },
            ],
          });
        case "items_list":
          return window.__items({
            keyword: (args || {}).keyword,
            category: (args || {}).category,
            onlyActive: (args || {}).onlyActive,
            limit: (args || {}).limit,
            offset: (args || {}).offset,
          }).then((d) => d.rows);
        case "items_count":
          return window.__items({
            keyword: (args || {}).keyword,
            category: (args || {}).category,
            onlyActive: (args || {}).onlyActive,
            limit: 500,
            offset: 0,
          }).then((d) => d.total);
        case "suppliers_list":
          return ok(window.__suppliers || []);
        case "item_create":
          return ok(99);
        default:
          return ok(null);
      }
    },
  };
  window.__suppliers = [];
});

await page.exposeFunction("__suppliersData", () => suppliers);
await page.addInitScript(() => {
  window.__suppliers = [
    { id: 1, name: "万杨五金", contact: "王师傅", phone: "13800000001", remark: null, active: true, hits: 904 },
    { id: 2, name: "鼎铭自动化", contact: null, phone: null, remark: null, active: true, hits: 754 },
    { id: 3, name: "智远自动化", contact: "李", phone: "13800000003", remark: null, active: true, hits: 270 },
    { id: 4, name: "停用供应商", contact: null, phone: null, remark: "不再合作", active: false, hits: 0 },
  ];
});

await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const errs0 = [];
page.on("pageerror", (e) => errs0.push(String(e)));
console.log("CONSOLE:", JSON.stringify(consoleMsgs.slice(0, 20)).slice(0, 700));
console.log("CALLS:", JSON.stringify(await page.evaluate(() => (window.__calls || []).map((c) => c.command))));
console.log("HTML:", (await page.locator("#root").innerHTML()).slice(0, 300));
console.log("BODYLEN:", (await page.locator("body").innerHTML()).length);
console.log("ROOT EXISTS:", await page.locator("#root").count());
await page.screenshot({ path: "shots/master-blank.png" });
console.log("PRE-NAV TEXT:", (await page.locator("body").innerText()).slice(0, 200));
const navButtons = await page.locator("nav button").allInnerTexts();
console.log("NAV:", JSON.stringify(navButtons));
if (!navButtons.some((t) => t.includes("基础资料"))) { console.log("ERR:", errs0); await browser.close(); process.exit(1); }
await page.getByRole("button", { name: /基础资料/ }).first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots/master-items.png" });
// 放大「只看在用」开关
const sw = page.locator('[aria-label="只看在用"]').first();
const box = await sw.boundingBox();
if (box) {
  await page.screenshot({
    path: "shots/master-switch-zoom.png",
    clip: { x: box.x - 20, y: box.y - 12, width: box.width + 160, height: box.height + 24 },
  });
}
const switchState = await page.evaluate(() => {
  const el = document.querySelector('[aria-label="只看在用"]');
  return el ? { checked: el.checked ?? el.getAttribute("aria-checked"), data: el.outerHTML.slice(0, 300) } : null;
});
console.log("SWITCH:", JSON.stringify(switchState));

const itemRows = await page.locator("tbody tr").count();
const itemText = await page.locator("body").innerText();

// 搜索
await page.getByLabel("搜索物料编码或名称").fill("轴承");
await page.waitForTimeout(900);
const afterSearch = await page.locator("tbody tr").count();
await page.screenshot({ path: "shots/master-search.png" });

// 切到供应商
await page.getByRole("tab", { name: /供应商/ }).click();
await page.waitForTimeout(900);
const supplierRows = await page.locator("tbody tr").count();
await page.screenshot({ path: "shots/master-suppliers.png" });

const btnHeights = await page.evaluate(() =>
  Array.from(new Set(
    Array.from(document.querySelectorAll("button"))
      .filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height > 20)
      .map((b) => Math.round(b.getBoundingClientRect().height)),
  )).sort((a, b) => a - b),
);
const btnLabels = await page.evaluate(() =>
  Array.from(document.querySelectorAll("button"))
    .filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height > 20)
    .slice(0, 12)
    .map((b) => ({ t: (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 12), h: Math.round(b.getBoundingClientRect().height) })),
);
console.log(JSON.stringify({ itemRows, afterSearch, supplierRows, hasStats: itemText.includes("物料总数"), btnHeights, btnLabels, pageErrors }, null, 2));
await browser.close();
