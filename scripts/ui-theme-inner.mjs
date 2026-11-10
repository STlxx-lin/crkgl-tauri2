// 浅色主题下把导入页与只读站页也看一遍（桩 Tauri 桥，布局用）。
import { chromium } from "playwright";

const stub = () => {
  const ok = (value) => Promise.resolve(value);
  window.__TAURI_INTERNALS__ = {
    invoke(command) {
      switch (command) {
        case "bootstrap":
          return ok({
            appVersion: "0.1.0",
            schemaVersion: 1,
            dbPath: "C:\\Users\\admin\\AppData\\Roaming\\coldcoffee.warehouse.ledger\\ledger.db",
            rowCount: 7677,
            importCount: 1,
            minDate: "2025-04-12",
            maxDate: "2026-08-31",
            inRows: 5887,
            outRows: 1790,
            web: { enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: ["http://127.0.0.1:80/", "http://192.168.0.107:80/"], staticReady: true, startedAt: "2026-11-09 15:40:02" },
            startupImport: null,
            lastError: null,
            sampleWorkbooks: [],
          });
        case "ledger_facets":
          return ok({ owners: ["乾力车间"], partners: [], buyers: ["严兰兰"], minDate: null, maxDate: null, itemCount: 0, inRows: 0, outRows: 0 });
        case "import_history":
          return ok([{ id: 1, fileName: "仓库出入库明细_5611_Modified.xlsm", fileHash: "9f2c", importedAt: "2026-11-09 15:40:06", rowCount: 7677, skippedCount: 0, note: null, liveRows: 7677 }]);
        case "web_status":
          return ok({ enabled: true, listening: true, port: 80, requestedPort: 80, error: null, urls: ["http://127.0.0.1:80/", "http://192.168.0.107:80/"], staticReady: true, startedAt: "2026-11-09 15:40:02" });
        case "web_access_log":
          return ok([
            { at: "2026-11-09 15:44:10", ip: "192.168.0.23", path: "GET /api/ledger/page", status: 200 },
            { at: "2026-11-09 15:44:12", ip: "192.168.0.23", path: "GET /api/ledger/facets", status: 200 },
            { at: "2026-11-09 15:46:33", ip: "203.0.113.9", path: "/", status: 403 },
          ]);
        default:
          return ok(null);
      }
    },
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(stub);
await page.addInitScript(() => {
  try {
    localStorage.setItem("ledger.theme", "light");
  } catch {}
});
await page.goto("http://127.0.0.1/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

await page.getByRole("button", { name: /导入/ }).first().click();
await page.waitForTimeout(900);
await page.screenshot({ path: "shots/light-import.png" });

await page.getByRole("button", { name: /只读站/ }).first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/light-remote.png" });

const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
console.log(JSON.stringify({ dark }));
await browser.close();
