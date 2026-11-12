// 界面字号：按档位缩放根字号（rem 体系），表格里写字号的固定 px 也换成 rem 跟随缩放。
// 只影响本机显示，不写数据库、不影响只读站。

export type FontScale = "small" | "normal" | "large" | "xlarge";

interface ScaleDef {
  id: FontScale;
  label: string;
  /** 根字号，rem 基准。16px 是浏览器默认 */
  rootPx: number;
  hint: string;
}

export const FONT_SCALES: ScaleDef[] = [
  { id: "small", label: "小", rootPx: 14, hint: "屏幕小、想多看几行" },
  { id: "normal", label: "标准", rootPx: 16, hint: "默认" },
  { id: "large", label: "大", rootPx: 18, hint: "看得清楚一些" },
  { id: "xlarge", label: "特大", rootPx: 20, hint: "仓库现场远看" },
];

export const DEFAULT_SCALE: FontScale = "normal";

const STORAGE_KEY = "ledger.fontScale";
const EVENT = "ledger:font-scale-change";

export function storedFontScale(): FontScale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && FONT_SCALES.some((s) => s.id === saved)) return saved as FontScale;
  } catch {
    // 隐私模式或存储被禁：用标准
  }
  return DEFAULT_SCALE;
}

export function rootPxOf(scale: FontScale): number {
  return (FONT_SCALES.find((s) => s.id === scale) ?? FONT_SCALES[1]).rootPx;
}

/** 把字号落到 <html>；persist 为 false 时只应用不写盘（首帧复原用）。 */
export function applyFontScale(scale: FontScale, { persist = true }: { persist?: boolean } = {}): void {
  const root = document.documentElement;
  // 只改根字号：BoardUI 的字号 token 全是 rem，会整体等比缩放
  root.style.fontSize = `${rootPxOf(scale)}px`;
  root.dataset.fontScale = scale;
  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, scale);
    } catch {
      // 存不下也不影响本次会话
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: scale }));
  }
}

export function onFontScaleChange(handler: (scale: FontScale) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<FontScale>).detail;
    handler(FONT_SCALES.some((s) => s.id === detail) ? detail : storedFontScale());
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
