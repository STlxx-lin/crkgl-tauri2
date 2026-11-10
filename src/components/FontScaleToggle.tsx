import { useCallback, useEffect, useState } from "react";
import { cx } from "@/utils/cx";
import { FONT_SCALES, applyFontScale, storedFontScale, onFontScaleChange, type FontScale } from "../lib/fontScale";

/**
 * 侧栏底部的字号控件：四档，点一下整体缩放。
 *
 * 只改根字号，BoardUI 的字号 token 全是 rem，界面会等比放大/缩小；
 * 表格里那些原本写死 px 的字号也已换成 rem，跟着一起走。
 */
export function FontScaleToggle({ className }: { className?: string }) {
  const [scale, setScale] = useState<FontScale>(() => storedFontScale());

  useEffect(() => {
    const initial = storedFontScale();
    setScale(initial);
    return onFontScaleChange(setScale);
  }, []);

  const choose = useCallback((next: FontScale) => {
    if (next === storedFontScale()) return;
    applyFontScale(next);
    setScale(next);
  }, []);

  return (
    <div
      role="group"
      aria-label="界面字号"
      className={cx("flex flex-col gap-1.5", className)}
    >
      <span className="text-caption-1-regular text-text-tertiary">字号</span>
      <div className="grid grid-cols-4 gap-0.5 rounded-lg bg-background-secondary-default p-0.5">
        {FONT_SCALES.map((option) => {
          const selected = scale === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              title={`${option.label}：${option.hint}`}
              onClick={() => choose(option.id)}
              className={cx(
                "h-7 rounded-md text-caption-1-semibold transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                selected
                  ? "bg-background-primary-default text-text-primary shadow-xs ring-1 ring-separator-border"
                  : "text-text-tertiary hover:text-text-secondary",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
