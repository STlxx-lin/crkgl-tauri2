// 验收：打印按实际行数出稿，设置项只作每页上限。
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
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(stub);

await page.goto(process.env.BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
await page.getByRole("button", { name: /开单/ }).first().click();
await page.waitForTimeout(900);

const addLines = async (count) => {
  for (let i = 0; i < count; i++) {
    if (i > 0) await page.getByRole("button", { name: /加一行/ }).click();
    await page.waitForTimeout(150);
    await page.locator("tbody tr").nth(i).locator("input").nth(0).fill(`D${1000 + i}`);
    await page.locator("tbody tr").nth(i).locator("input").nth(1).fill("WG-A-001");
    await page.locator("tbody tr").nth(i).locator("input").nth(2).fill("外卡（轴）φ10");
    await page.locator("tbody tr").nth(i).locator("input").nth(3).fill("个");
    await page.locator("tbody tr").nth(i).locator("input").nth(4).fill(String(i + 1));
  }
  await page.waitForTimeout(400);
};

const readPrint = () =>
  page.evaluate(() => {
    const papers = Array.from(document.querySelectorAll(".print-paper"));
    return {
      papers: papers.length,
      rowsPerPage: papers.map((p) => p.querySelectorAll(".print-table tbody tr").length),
      hint: document.querySelector(".print-overlay span")?.innerText ?? "",
      // 合计行不算明细行
      dataRows: papers.reduce(
        (sum, p) =>
          sum +
          Array.from(p.querySelectorAll(".print-table tbody tr")).filter(
            (tr) => !tr.hasAttribute("aria-hidden") && !tr.classList.contains("print-total"),
          ).length,
        0,
      ),
    };
  });

// 1) 3 行：应该只打 3 行，不补空行
await addLines(3);
await page.getByRole("button", { name: /A4 打印/ }).click();
await page.waitForTimeout(800);
const three = await readPrint();
await page.screenshot({ path: "shots/print-3rows.png" });
await page.getByRole("button", { name: /关闭/ }).click();
await page.waitForTimeout(300);

// 2) 加到 20 行：默认上限 18，应分成两页（18 + 2）
for (let i = 3; i < 20; i++) {
  await page.getByRole("button", { name: /加一行/ }).click();
  await page.waitForTimeout(120);
  await page.locator("tbody tr").nth(i).locator("input").nth(1).fill("WG-A-001");
  await page.locator("tbody tr").nth(i).locator("input").nth(4).fill("1");
}
await page.waitForTimeout(500);
await page.getByRole("button", { name: /A4 打印/ }).click();
await page.waitForTimeout(800);
const twenty = await readPrint();

console.log(JSON.stringify({ three, twenty, errors }, null, 2));
await browser.close();
