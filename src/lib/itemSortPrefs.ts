// 基础资料物料列表的排序偏好。
// 存 localStorage：只影响本机这个列表怎么排，不必进数据库，也不用同步到只读站。

export type ItemSort = "code" | "code_desc" | "name" | "newest" | "oldest";

const STORAGE_KEY = "ledger.items.sort";
const EVENT = "ledger:items-sort-change";
const DEFAULT_SORT: ItemSort = "code";

const VALID: ItemSort[] = ["code", "code_desc", "name", "newest", "oldest"];

/** 读取上次选的排序；认不出来的值回落到按编码升序。 */
export function storedItemSort(): ItemSort {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && (VALID as string[]).includes(raw)) return raw as ItemSort;
  } catch {
    // 隐私模式或存储被禁：用默认值
  }
  return DEFAULT_SORT;
}

export function saveItemSort(sort: ItemSort): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, sort);
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: sort }));
}

/** 同一窗口里若开了两处列表，保持排序一致。 */
export function onItemSortChange(handler: (sort: ItemSort) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ItemSort>).detail;
    handler(detail && VALID.includes(detail) ? detail : storedItemSort());
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
