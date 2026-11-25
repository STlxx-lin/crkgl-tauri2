import { describe, expect, it } from "vitest";
import {
  PRINT_ROWS_DEFAULT,
  PRINT_ROWS_MAX,
  PRINT_ROWS_MIN,
  onPrintRowsChange,
  savePrintRows,
  storedPrintRows,
} from "./printPrefs";

describe("storedPrintRows：A4 每页行数上限", () => {
  it("没存过时用默认值", () => {
    expect(storedPrintRows()).toBe(PRINT_ROWS_DEFAULT);
  });

  it("存过的合法值原样返回", () => {
    savePrintRows(12);
    expect(storedPrintRows()).toBe(12);
  });

  it("越界值回落到默认值，不是取最近边界", () => {
    window.localStorage.setItem("ledger.print.rows", String(PRINT_ROWS_MAX + 5));
    expect(storedPrintRows()).toBe(PRINT_ROWS_DEFAULT);
    window.localStorage.setItem("ledger.print.rows", "0");
    expect(storedPrintRows()).toBe(PRINT_ROWS_DEFAULT);
  });

  it("非数字/空串/小数都回落到默认值", () => {
    for (const raw of ["", "abc", "7.5"]) {
      window.localStorage.setItem("ledger.print.rows", raw);
      expect(storedPrintRows()).toBe(PRINT_ROWS_DEFAULT);
    }
  });
});

describe("savePrintRows：写盘前夹到合法区间", () => {
  it("超过上限写成上限", () => {
    savePrintRows(999);
    expect(storedPrintRows()).toBe(PRINT_ROWS_MAX);
  });

  it("小于下限写成下限", () => {
    savePrintRows(-3);
    expect(storedPrintRows()).toBe(PRINT_ROWS_MIN);
  });

  it("小数四舍五入后存整数", () => {
    savePrintRows(9.6);
    expect(storedPrintRows()).toBe(10);
  });
});

describe("onPrintRowsChange：设置页改完打印视图跟着变", () => {
  it("收到事件时回调新值", () => {
    const seen: number[] = [];
    const off = onPrintRowsChange((rows) => seen.push(rows));
    savePrintRows(15);
    off();
    expect(seen).toEqual([15]);
  });

  it("取消订阅后不再回调", () => {
    const seen: number[] = [];
    const off = onPrintRowsChange((rows) => seen.push(rows));
    off();
    savePrintRows(11);
    expect(seen).toEqual([]);
  });
});
