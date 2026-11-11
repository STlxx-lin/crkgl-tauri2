// 金额、数量、日期的统一格式。屏幕上一律 tabular-nums。

const yuan = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactYuan = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const qtyFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 3,
});

const integerFormat = new Intl.NumberFormat("zh-CN");

/** 分 → `¥1,234.56`；空值给 `—`。 */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return "¥" + yuan.format(cents / 100);
}

/** 分 → `12.34`（不带货币符号，表格里省空间）。 */
export function amount(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return yuan.format(cents / 100);
}

/** 图表轴上的缩写：`¥12.3万` / `¥1.2亿`。 */
export function moneyCompact(cents: number): string {
  const value = cents / 100;
  if (Math.abs(value) >= 100_000_000) return "¥" + (value / 100_000_000).toFixed(1) + "亿";
  if (Math.abs(value) >= 10_000) return "¥" + (value / 10_000).toFixed(1) + "万";
  return "¥" + compactYuan.format(value);
}

export function qty(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return qtyFormat.format(value);
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return integerFormat.format(value);
}

/** `2025-10-30` → `2025-10-30`；已经是目标格式就不动。 */
export function date(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** 环比：正数带 `+`，没有基期给空。 */
export function delta(current: number, previous: number): { text: string; direction: "up" | "down" | "flat" } | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? null : { text: "新增", direction: "up" };
  const ratio = ((current - previous) / Math.abs(previous)) * 100;
  const text = (ratio >= 0 ? "+" : "") + ratio.toFixed(1) + "%";
  return { text, direction: ratio > 0.05 ? "up" : ratio < -0.05 ? "down" : "flat" };
}

export function percentText(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(1) + "%";
}

/** 提醒标签翻成中文。 */
export function flagLabel(flag: string): string {
  switch (flag) {
    case "no_date":
      return "日期缺失";
    case "no_code":
      return "无编码";
    case "no_price":
      return "无单价";
    case "no_amount":
      return "无金额";
    case "no_qty":
      return "数量缺失";
    case "qty_mismatch":
      return "数量×单价≠合计";
    default:
      return flag;
  }
}

export function kindLabel(kind: string): string {
  if (kind === "in") return "入库";
  if (kind === "out") return "出库";
  // 月度进销存宽表拆出来的流水，方向逐行不同
  if (kind === "pivot") return "进销存";
  return kind;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `2025-10-30 10:22:01` → `10-30 10:22` */
export function shortTs(value: string | null | undefined): string {
  if (!value) return "—";
  const trimmed = value.replace(/-/g, "/");
  return trimmed.length >= 16 ? trimmed.slice(5, 16) : trimmed;
}

const priceFormat = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

/**
 * 单价（万分之一元）→ 文本。
 * 源表里大量单价是厘/丝级（0.202、0.216），所以最多保留 4 位小数，
 * 并去掉无意义的尾零：1.5 不显示成 1.5000。
 */
export function priceText(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return "—";
  return priceFormat.format(micros / 10_000);
}

/**
 * 编辑框里的单价初值：保留两位小数（42.0000 -> 42，42.1000 -> 42.1）。
 * 台账里仍有厘级单价，但那是历史数据；开单录入按两位走，避免一屏全是尾零。
 */
export function priceInput(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return "";
  const fixed = (micros / 10_000).toFixed(2);
  // 只去掉小数末尾多余的 0，不碰整数部分的 0
  return fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** 输入框文本（元）→ 万分之一元。 */
export function parsePriceToMicros(text: string): number | null {
  const cleaned = text.replace(/[,，¥￥\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 10_000) : null;
}
