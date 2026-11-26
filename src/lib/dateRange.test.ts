import { describe, expect, it } from "vitest";
import { isoDate, RANGE_PRESETS, rangeFor } from "./dateRange";

describe("isoDate：本地日期串", () => {
  it("补零到 YYYY-MM-DD", () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(isoDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("rangeFor：区间预设", () => {
  it("全部不加日期条件", () => {
    expect(rangeFor("all")).toEqual({ from: null, to: null });
  });

  it("本月从 1 号到今天", () => {
    const now = new Date();
    const { from, to } = rangeFor("month");
    expect(from).toBe(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`);
    expect(to).toBe(isoDate(now));
  });

  it("上月首尾都落在上个月，跨年也正确", () => {
    // 1 月的「上月」是去年 12 月：手写月份减法很容易在这里翻车
    const now = new Date();
    const { from, to } = rangeFor("lastMonth");
    const firstOfLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastOfLast = new Date(now.getFullYear(), now.getMonth(), 0);
    expect(from).toBe(isoDate(firstOfLast));
    expect(to).toBe(isoDate(lastOfLast));
    // 闭区间：末日的次日一定已经跨月
    expect(to! < from!).toBe(false);
  });

  it("本年从 1 月 1 日到今天", () => {
    const now = new Date();
    expect(rangeFor("thisYear")).toEqual({
      from: `${now.getFullYear()}-01-01`,
      to: isoDate(now),
    });
  });

  it("未知档位按「全部」处理，不漏数据", () => {
    expect(rangeFor("whatever")).toEqual({ from: null, to: null });
  });
});

describe("RANGE_PRESETS", () => {
  it("每个档位都有 id 与中文标签，id 不重复", () => {
    const ids = RANGE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of RANGE_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });
});
