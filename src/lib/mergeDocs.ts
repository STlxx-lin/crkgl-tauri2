// 台账「按单据合并」：把同一张单据的明细行折叠成一行显示。
// 服务端分页不变，只在当前页内合并；跨页的同号单据各自成行。
//
// 合并按「单号分组」而不是「相邻行」：台账支持按金额/数量排序，这时同一张
// 单的明细会被打散到整页各处，相邻合并会把它拆成好几行，页脚却仍写着
// 「合并自 N 行」，口径自相矛盾。

import type { LedgerRow } from "./types";

export const MERGE_STORAGE_KEY = "ledger.mergeByDoc";
const MERGE_EVENT = "ledger:merge-by-doc-change";

/** 合并后的一行：字段与 LedgerRow 同形，另外带上这组包含的明细行数与首行 id。 */
export interface MergedRow extends LedgerRow {
  /** 这组来自几条明细（1 表示没合并的单行） */
  groupCount: number;
  /** 组内每行的 id，详情/选中要回到明细 */
  memberIds: number[];
  /** 物料名的完整列表（已截断的 itemName 之外，给 title 用） */
  allItemNames: string[];
}

/** 物料名最多拼几个，多了用「等 N 项」。 */
const NAME_LIMIT = 3;

export function mergeRowsByDoc(rows: LedgerRow[], merged: boolean): MergedRow[] {
  if (!merged) {
    return rows.map((row) => ({
      ...row,
      groupCount: 1,
      memberIds: [row.id],
      allItemNames: row.itemName ? [row.itemName] : [],
    }));
  }

  // 先按单号分组，再按「组内第一行在本页的位置」输出，
  // 这样合并结果与排序方式无关，且行序仍跟着当前排序走。
  const groups = new Map<string, LedgerRow[]>();
  rows.forEach((row, index) => {
    // 没有单号的行不参与合并，用带下标的唯一键让它各占一行
    const key = groupKey(row) ?? `#row-${index}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  });
  // Map 保持插入顺序，插入顺序就是「组内第一行出现的位置」
  return Array.from(groups.values(), combine);
}

/** 同号 + 同类型才算同一张单；空单号返回 null。 */
function groupKey(row: LedgerRow): string | null {
  const docNo = row.docNo?.trim();
  if (!docNo) return null;
  return `${row.kind}|${docNo}`;
}

function combine(group: LedgerRow[]): MergedRow {
  const first = group[0];
  const names: string[] = [];
  for (const row of group) {
    const name = row.itemName?.trim();
    if (name && !names.includes(name)) names.push(name);
  }

  const qty = group.reduce((sum, row) => sum + (row.qty ?? 0), 0);
  const anyQty = group.some((row) => row.qty !== null);
  const amount = group.reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
  const anyAmount = group.some((row) => row.amountCents !== null);

  const flags: LedgerRow["flags"] = [];
  for (const row of group) {
    for (const flag of row.flags) if (!flags.includes(flag)) flags.push(flag);
  }

  return {
    ...first,
    itemCode: group.length === 1 ? first.itemCode : null,
    itemName: summarizeNames(names),
    unit: group.length === 1 ? first.unit : null,
    qty: anyQty ? qty : null,
    priceMicros: group.length === 1 ? first.priceMicros : null,
    amountCents: anyAmount ? amount : null,
    flags,
    groupCount: group.length,
    memberIds: group.map((row) => row.id),
    allItemNames: names,
  };
}

export function summarizeNames(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length <= NAME_LIMIT) return names.join("、");
  return `${names.slice(0, NAME_LIMIT).join("、")} 等 ${names.length} 项`;
}

/** 读取开关状态；没存过就是关闭（和以前的逐行台账一致）。 */
export function storedMergeByDoc(): boolean {
  try {
    return window.localStorage.getItem(MERGE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveMergeByDoc(on: boolean): void {
  try {
    window.localStorage.setItem(MERGE_STORAGE_KEY, on ? "1" : "0");
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(MERGE_EVENT, { detail: on }));
}

export function onMergeByDocChange(handler: (on: boolean) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<boolean>).detail;
    handler(typeof detail === "boolean" ? detail : storedMergeByDoc());
  };
  window.addEventListener(MERGE_EVENT, listener);
  return () => window.removeEventListener(MERGE_EVENT, listener);
}
