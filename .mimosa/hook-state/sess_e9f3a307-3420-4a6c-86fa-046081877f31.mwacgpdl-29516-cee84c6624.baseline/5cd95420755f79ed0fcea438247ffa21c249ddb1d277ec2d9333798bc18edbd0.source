import { useCallback, useEffect, useState } from "react";
import { RiMoonLine, RiSunLine } from "@remixicon/react";
import { cx } from "@/utils/cx";
import { applyTheme, currentTheme, storedTheme, subscribeTheme, type ThemeMode } from "../lib/theme";

const OPTIONS: { mode: ThemeMode; label: string; Icon: typeof RiSunLine }[] = [
  { mode: "light", label: "浅色", Icon: RiSunLine },
  { mode: "dark", label: "深色", Icon: RiMoonLine },
];

/**
 * 侧栏底部的主题分段控件：两个按钮加一个滑块。
 *
 * 滑块宽度按按钮均分算（`w-[calc(50%-2px)]`），不写死像素，
 * 这样按钮文案或字号变化时滑块也不会只盖住半个按钮。
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<ThemeMode>(() => currentTheme());

  useEffect(() => {
    const initial = currentTheme() || storedTheme();
    setTheme(initial);
    return subscribeTheme(setTheme);
  }, []);

  const choose = useCallback((mode: ThemeMode) => {
    if (mode === currentTheme()) return;
    applyTheme(mode);
    setTheme(mode);
  }, []);

  const dark = theme === "dark";

  return (
    <div
      role="group"
      aria-label="主题"
      className={cx(
        "relative inline-flex w-fit items-center gap-0.5 rounded-lg bg-background-secondary-default p-0.5",
        className,
      )}
    >
      {/* 滑块：宽度 = 按钮宽度（各占一半），向左/右平移自身宽度 */}
      <span
        aria-hidden
        className={cx(
          "pointer-events-none absolute bottom-0.5 start-0.5 top-0.5 w-[calc(50%-2px)] rounded-md bg-background-primary-default shadow-xs ring-1 ring-separator-border",
          "transition-transform duration-200 ease",
          dark ? "translate-x-[calc(100%+2px)] rtl:-translate-x-[calc(100%+2px)]" : "translate-x-0",
        )}
      />
      {OPTIONS.map(({ mode, label, Icon }) => {
        const selected = theme === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={selected}
            title={`${label}主题`}
            onClick={() => choose(mode)}
            className={cx(
              "relative z-10 flex h-8 flex-1 items-center justify-center gap-1 rounded-md px-2 text-caption-1-semibold transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              selected ? "text-text-primary" : "text-text-tertiary hover:text-text-secondary",
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
