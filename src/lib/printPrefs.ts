// 打印偏好：A4 打印视图一页最多放多少行明细。
//
// 打印按单据实际行数出稿：有几行打几行，不补空行；超过上限才分页。
// 上限只是「别一页塞太多」的约束，所以默认给足（18 行），
// 常用的 5~10 行单据永远是一页一张，不会出现大片空白。
// 存 localStorage：只影响本机打印排版，不需要进数据库，也不用同步到只读站。

const STORAGE_KEY = "ledger.print.rows";
const EVENT = "ledger:print-rows-change";

export const PRINT_ROWS_MIN = 1;
export const PRINT_ROWS_MAX = 40;
export const PRINT_ROWS_DEFAULT = 18;

/** 读取每页行数上限；脏数据一律回落到默认值。 */
export function storedPrintRows(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isInteger(n) && n >= PRINT_ROWS_MIN && n <= PRINT_ROWS_MAX) return n;
  } catch {
    // 隐私模式或存储被禁：按默认值
  }
  return PRINT_ROWS_DEFAULT;
}

export function savePrintRows(rows: number): void {
  const value = Math.min(PRINT_ROWS_MAX, Math.max(PRINT_ROWS_MIN, Math.round(rows)));
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

/** 设置页改了上限后，打印视图跟着更新。 */
export function onPrintRowsChange(handler: (rows: number) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<number>).detail;
    handler(typeof detail === "number" ? detail : storedPrintRows());
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
