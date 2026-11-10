// 打印偏好：A4 打印视图每页预留的明细行数。
// 纸单固定 8 行（不足补空行、超了分页），现场也有用 10 行或 12 行的，所以给到配置。
// 存 localStorage：只影响本机打印排版，不需要进数据库，也不用同步到只读站。

const STORAGE_KEY = "ledger.print.rows";
const EVENT = "ledger:print-rows-change";

export const PRINT_ROWS_MIN = 1;
export const PRINT_ROWS_MAX = 30;
export const PRINT_ROWS_DEFAULT = 8;

/** 读取每页明细行数；脏数据一律回落到默认的 8 行。 */
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

/** 设置页改了行数后，打印视图/开单页跟着更新。 */
export function onPrintRowsChange(handler: (rows: number) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<number>).detail;
    handler(typeof detail === "number" ? detail : storedPrintRows());
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
