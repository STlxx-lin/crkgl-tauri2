// 验收：开单页「单据查询」侧栏可收起/展开，状态记住。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  window.__TAURI_INTERNALS__ = {
    invoke(command) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 7677, importCount: 1,
            minDate: "2025-10-30", maxDate: "2026-08-31", inRows: 5887, outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: [], staticReady: true, startedAt: "x" },
            startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "voucher_next_no":
          return ok("20261110001");
        case "ledger_facets":
          return ok({ owners: [], partners: ["万杨五金"], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "suppliers_list":
          return ok([{ name: "万杨五金", hits: 12 }]);
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
const page = await browser.newPage({ viewport: { width: 1500, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

const state = () =>
  page.evaluate(() => {
    const h2 = Array.from(document.querySelectorAll("h2")).find((el) => el.innerText.trim() === "单据查询");
    const toggle = Array.from(document.querySelectorAll("button")).find((b) =>
      /收起查询|单据查询/.test(b.innerText.trim()),
    );
    const grid = document.querySelector("main div.grid");
    // 单据主体（含「入库单」标题）的实际宽度：收起后应变宽
    const sheet = Array.from(document.querySelectorAll("section")).find((s) => s.innerText.includes("温州乾力机械有限公司"));
    return {
      sidebarVisible: Boolean(h2),
      toggleLabel: toggle?.innerText.trim() ?? null,
      pressed: toggle?.getAttribute("aria-pressed") ?? null,
      sheetWidth: sheet ? Math.round(sheet.getBoundingClientRect().width) : null,
      gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
    };
  });

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);

const opened = await state();
await page.screenshot({ path: "shots/sidebar-open.png" });

await page.getByRole("button", { name: /收起查询/ }).click();
await page.waitForTimeout(500);
const collapsed = await state();
await page.screenshot({ path: "shots/sidebar-collapsed.png" });

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(800);
const afterReload = await state();

// 再展开
await page.getByRole("button", { name: /^单据查询$/ }).click();
await page.waitForTimeout(500);
const reopened = await state();

console.log(JSON.stringify({ opened, collapsed, afterReload, reopened, errors }, null, 2));
await browser.close();
