import { describe, expect, it } from "vitest";
import type { LedgerRow } from "./types";
import { mergeRowsByDoc, summarizeNames } from "./mergeDocs";

function row(patch: Partial<LedgerRow> & Pick<LedgerRow, "id">): LedgerRow {
  return {
    kind: "in",
    docDate: "2025-10-30",
    docNo: "20251030001",
    deliveryNo: null,
    itemCode: null,
    itemName: null,
    spec: null,
    unit: null,
    qty: null,
    priceMicros: null,
    amountCents: null,
    remark: null,
    partner: null,
    buyer: null,
    owner: null,
    receiver: null,
    flags: [],
    sheet: "入库明细",
    rowNo: 2,
    importId: null,
    createdAt: null,
    isReturn: false,
    sourceVoucherId: null,
    sourceDocNo: null,
    ...patch,
  };
}

describe("mergeRowsByDoc：按单号分组", () => {
  it("关闭合并时每行独立，groupCount 都是 1", () => {
    const rows = [row({ id: 1, docNo: "A" }), row({ id: 2, docNo: "A" })];
    const merged = mergeRowsByDoc(rows, false);
    expect(merged).toHaveLength(2);
    expect(merged.every((r) => r.groupCount === 1)).toBe(true);
  });

  it("相邻同号行合并成一行，数量与金额求和", () => {
    const rows = [
      row({ id: 1, docNo: "A", qty: 2, amountCents: 100, itemName: "螺丝" }),
      row({ id: 2, docNo: "A", qty: 3, amountCents: 200, itemName: "螺母" }),
    ];
    const [merged] = mergeRowsByDoc(rows, true);
    expect(merged.groupCount).toBe(2);
    expect(merged.memberIds).toEqual([1, 2]);
    expect(merged.qty).toBe(5);
    expect(merged.amountCents).toBe(300);
    expect(merged.allItemNames).toEqual(["螺丝", "螺母"]);
  });

  it("排序后被打散的同单仍合并（#32）", () => {
    // 按金额排序时同一张单的三行可能被别的单隔开
    const rows = [
      row({ id: 1, docNo: "A", qty: 1 }),
      row({ id: 2, docNo: "B", qty: 1 }),
      row({ id: 3, docNo: "A", qty: 1 }),
      row({ id: 4, docNo: "B", qty: 1 }),
      row({ id: 5, docNo: "A", qty: 1 }),
    ];
    const merged = mergeRowsByDoc(rows, true);
    expect(merged).toHaveLength(2);
    // 组按「第一行出现的位置」排序：A 先出现，B 后出现
    expect(merged[0].memberIds).toEqual([1, 3, 5]);
    expect(merged[1].memberIds).toEqual([2, 4]);
    expect(merged[0].qty).toBe(3);
  });

  it("空单号不参与合并，各自成行", () => {
    const rows = [row({ id: 1, docNo: null }), row({ id: 2, docNo: "   " }), row({ id: 3, docNo: "A" })];
    const merged = mergeRowsByDoc(rows, true);
    expect(merged).toHaveLength(3);
    expect(merged.every((r) => r.groupCount === 1)).toBe(true);
  });

  it("同号但类型不同（入库/出库）不能合并", () => {
    const rows = [row({ id: 1, docNo: "X", kind: "in" }), row({ id: 2, docNo: "X", kind: "out" })];
    const merged = mergeRowsByDoc(rows, true);
    expect(merged).toHaveLength(2);
  });

  it("合并行的单价与物料编码置空，避免误导", () => {
    const rows = [
      row({ id: 1, docNo: "A", itemCode: "C1", unit: "个", priceMicros: 100 }),
      row({ id: 2, docNo: "A", itemCode: "C2", unit: "个", priceMicros: 200 }),
    ];
    const [merged] = mergeRowsByDoc(rows, true);
    expect(merged.itemCode).toBeNull();
    expect(merged.priceMicros).toBeNull();
    expect(merged.unit).toBeNull();
  });

  it("合并行的提醒标签取并集且去重", () => {
    const rows = [
      row({ id: 1, docNo: "A", flags: ["no_code", "qty_outlier"] }),
      row({ id: 2, docNo: "A", flags: ["no_code"] }),
    ];
    const [merged] = mergeRowsByDoc(rows, true);
    expect(merged.flags).toEqual(["no_code", "qty_outlier"]);
  });
});

describe("summarizeNames：物料名拼接", () => {
  it("空列表返回 null", () => {
    expect(summarizeNames([])).toBeNull();
  });

  it("三个以内全列出来", () => {
    expect(summarizeNames(["A", "B", "C"])).toBe("A、B、C");
  });

  it("超过三个只列前三个并写总数", () => {
    expect(summarizeNames(["A", "B", "C", "D", "E"])).toBe("A、B、C 等 5 项");
  });
});
