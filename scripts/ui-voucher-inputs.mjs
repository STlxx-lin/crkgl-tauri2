// 验收：开单页行内输入框和签字输入框默认可见（有边框和底色）。
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
const page = await browser.newPage({ viewport: { width: 1500, height: 760 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);

// 采样几个输入框的边框与底色，确认不是透明的
const styles = await page.evaluate(() => {
  const pick = (label) => {
    const el = Array.from(document.querySelectorAll("input")).find((i) => i.getAttribute("aria-label") === label);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      label,
      border: cs.borderTopColor,
      borderWidth: cs.borderTopWidth,
      background: cs.backgroundColor,
    };
  };
  const row = document.querySelector("tbody tr");
  const rowInputs = row ? Array.from(row.querySelectorAll("input")).slice(0, 3) : [];
  return {
    named: [pick("第 1 行送货单号"), pick("采购人"), pick("仓管"), pick("领用人")].filter(Boolean),
    rowInputs: rowInputs.map((el) => {
      const cs = getComputedStyle(el);
      return { placeholder: el.placeholder, border: cs.borderTopColor, background: cs.backgroundColor };
    }),
  };
});
await page.screenshot({ path: "shots/voucher-inputs.png" });
console.log(JSON.stringify({ styles, errors }, null, 2));
await browser.close();
