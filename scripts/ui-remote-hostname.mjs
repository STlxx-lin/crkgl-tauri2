// 验收：只读站地址列表里出现「电脑名」地址。
// 只用于验收，不参与生产构建。
import { chromium } from "playwright";

const urls = [
  "http://127.0.0.1:80/",
  "http://desktop-eof751h:80/",
  "http://172.21.112.1:80/",
  "http://192.168.0.107:80/",
];

const stub = () => {
  const ok = (v) => Promise.resolve(v);
  const web = {
    enabled: true,
    listening: true,
    port: 80,
    requestedPort: 80,
    error: null,
    urls: window.__urls,
    staticReady: true,
    startedAt: "2026-11-10 14:15:57",
  };
  window.__TAURI_INTERNALS__ = {
    invoke(command) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0", schemaVersion: 7, dbPath: "x", rowCount: 6, importCount: 1,
            minDate: "2026-09-01", maxDate: "2026-09-02", inRows: 6, outRows: 0,
            web, startupImport: null, lastError: null, sampleWorkbooks: [],
          });
        case "web_status":
          return ok(web);
        case "web_access_log":
        case "suppliers_list":
        case "voucher_list":
        case "voucher_search":
          return ok([]);
        case "ledger_facets":
          return ok({ owners: [], partners: [], buyers: [], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "ledger_page":
          return ok({ rows: [], total: 0, page: 1, pageSize: 100, totals: { rows: 0, inRows: 0, outRows: 0, amountInCents: 0, amountOutCents: 0, qtyIn: 0, qtyOut: 0, docCount: 0, itemCount: 0 } });
        case "voucher_next_no":
          return ok("20261110001");
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
await page.addInitScript((u) => { window.__urls = u; }, urls);
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /只读站/ }).first().click();
await page.waitForTimeout(1000);

const listed = await page.evaluate(() =>
  Array.from(document.querySelectorAll("code")).map((el) => {
    const row = el.closest("div");
    return { url: el.innerText.trim(), badge: row?.innerText.includes("电脑名") ?? false };
  }),
);
await page.screenshot({ path: "shots/remote-hostname.png" });
console.log(JSON.stringify({ listed, errors }, null, 2));
await browser.close();
