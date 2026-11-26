// 台账与开单记录共用的日期区间预设。
//
// 两页原本各有一份 `rangeFor`，改档位时必然漏改一处；这里抽出来统一，
// 语义保持一致：全部 / 本月 / 上月 / 本年。

/** `2026-09-03` 这类本地日期串（不做时区换算，界面上全是本地日历口径）。 */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const RANGE_PRESETS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "month", label: "本月" },
  { id: "lastMonth", label: "上月" },
  { id: "thisYear", label: "本年" },
];

/**
 * 预设 → 起止日期。`all` 返回两个 null，调用方据此不加日期条件。
 *
 * 用 `new Date(y, m, 0)` 取上月最后一天，闰年与大小月都由 Date 自己算，
 * 不手写 28/30/31 判断。
 */
export function rangeFor(preset: string): { from: string | null; to: string | null } {
  const now = new Date();
  if (preset === "month") {
    return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
  }
  if (preset === "lastMonth") {
    return {
      from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  if (preset === "thisYear") {
    return { from: `${now.getFullYear()}-01-01`, to: isoDate(now) };
  }
  return { from: null, to: null };
}
