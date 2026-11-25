import { describe, expect, it } from "vitest";
import { delta, fileSize, money, parsePriceToMicros, priceInput, priceInput4, qty, shortTs } from "../lib/format";

describe("money / amount / qty 的边界", () => {
  it("空值显示破折号，不是 0", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(qty(null)).toBe("—");
  });

  it("金额按分转元，负数保留符号", () => {
    expect(money(0)).toBe("¥0.00");
    expect(money(123_456)).toBe("¥1,234.56");
    expect(money(-150)).toBe("¥-1.50");
  });
});

describe("delta：环比方向", () => {
  it("两边都不可计算时返回 null", () => {
    expect(delta(Number.NaN, 1)).toBeNull();
    expect(delta(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("基期为 0 且本期为 0 时没有环比", () => {
    expect(delta(0, 0)).toBeNull();
  });

  it("基期为 0、本期为正：新增 up", () => {
    expect(delta(100, 0)).toEqual({ text: "新增", direction: "up" });
  });

  it("基期为 0、本期为负：方向必须 down（#45）", () => {
    const result = delta(-80, 0);
    expect(result?.direction).toBe("down");
    expect(result?.text).toContain("负");
  });

  it("常规增长/下降/持平的百分比", () => {
    expect(delta(120, 100)).toEqual({ text: "+20.0%", direction: "up" });
    expect(delta(80, 100)).toEqual({ text: "-20.0%", direction: "down" });
    // 百分比保留一位小数，0.0% 仍带 +，但方向必须判成 flat
    expect(delta(100, 100)?.direction).toBe("flat");
  });
});

describe("fileSize：进位不能出现 1024 KB", () => {
  it("小于 1KB 用字节", () => {
    expect(fileSize(0)).toBe("0 B");
    expect(fileSize(1023)).toBe("1023 B");
  });

  it("1023.5 KB 直接进位到 1.0 MB（#45）", () => {
    // 1024*1024 - 512 = 1048064；再少 1 字节仍在 KB 档
    expect(fileSize(1024 * 1024 - 513)).toMatch(/KB$/);
    expect(fileSize(1024 * 1024 - 512)).toBe("1.0 MB");
  });

  it("MB 档保留一位小数", () => {
    expect(fileSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });
});

describe("shortTs：按月日时分显示", () => {
  it("空值给破折号", () => {
    expect(shortTs(null)).toBe("—");
  });

  it("正常时间戳按本地时区格式化（#45）", () => {
    const text = shortTs("2025-10-30 10:22:01");
    expect(text).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(text.endsWith("10:22")).toBe(true);
    expect(text.startsWith("10-30")).toBe(true);
  });

  it("解析不了时退回字符串切法，不显示 Invalid Date", () => {
    const text = shortTs("不是时间");
    expect(text).not.toContain("Invalid");
  });
});

describe("单价：录入精度", () => {
  it("priceInput 去掉尾零但保留两位", () => {
    expect(priceInput(420_000)).toBe("42");
    expect(priceInput(421_000)).toBe("42.1");
    expect(priceInput(null)).toBe("");
  });

  it("priceInput4 保留厘/丝级单价（#28）", () => {
    expect(priceInput4(2_020)).toBe("0.202");
    expect(priceInput4(2_160)).toBe("0.216");
    expect(priceInput4(420_000)).toBe("42");
  });

  it("parsePriceToMicros 与 priceInput4 往返一致", () => {
    for (const micros of [2_020, 2_160, 420_000, 1, 9_999]) {
      const text = priceInput4(micros);
      expect(parsePriceToMicros(text)).toBe(micros);
    }
  });

  it("输入里的千分位/货币符号/空白被忽略", () => {
    expect(parsePriceToMicros("¥ 1,234.5")).toBe(12_345_000);
    expect(parsePriceToMicros("")).toBeNull();
    expect(parsePriceToMicros("abc")).toBeNull();
  });
});
