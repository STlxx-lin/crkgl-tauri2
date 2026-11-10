// 开单偏好：记住上一次保存的采购人（入库单）。
// 仓库常年就那几个人开单，每次重填太麻烦；没有记录时回落到内置默认值。

const STORAGE_KEY = "ledger.lastBuyer";
const EVENT = "ledger:last-buyer-change";

/** 没有历史记录时用的默认采购人。 */
export const DEFAULT_BUYER = "严兰兰";

export function storedBuyer(): string {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved !== null && saved.trim() !== "") return saved.trim();
  } catch {
    // 隐私模式或存储被禁：用内置默认值
  }
  return DEFAULT_BUYER;
}

export function saveBuyer(buyer: string): void {
  const value = buyer.trim();
  if (!value) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

/** 同一窗口开了多处开单入口时保持同步。 */
export function onBuyerChange(handler: (buyer: string) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<string>).detail;
    handler(typeof detail === "string" && detail.trim() ? detail : storedBuyer());
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
