import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";
import { cx } from "@/utils/cx";

export interface PickerOption {
  value: string;
  /** 副标题，可空 */
  hint?: string;
}

interface ComboPickerProps {
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** 允许输入选项以外的新值（供应商、类别都需要） */
  allowCustom?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  /** 空列表时的提示 */
  emptyText?: string;
}

/**
 * 可搜索下拉。
 *
 * 为什么不用 BoardUI 的 ComboBox：它内部的 AriaInput 在 AriaGroup 里拿不到
 * ComboBox 的值，选中后输入框仍显示占位符。这个组件自己持有文本状态，
 * 下拉用 portal + fixed 定位，避免被表格的 overflow 裁掉。
 */
export function ComboPicker({
  value,
  options,
  onChange,
  placeholder = "选择或输入",
  allowCustom = true,
  disabled,
  ariaLabel,
  className,
  emptyText = "没有匹配项",
}: ComboPickerProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);

  // 外部值变化时同步输入框（例如切换单据、重置表单）
  useEffect(() => {
    setText(value);
  }, [value]);

  const filtered = useMemo(() => {
    const keyword = (open ? text : "").trim();
    if (!keyword || keyword === value) return options;
    return options.filter((o) => o.value.includes(keyword));
  }, [open, text, value, options]);

  const measure = () => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 220) });
  };

  useEffect(() => {
    if (!open) return;
    measure();
    const onScroll = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!boxRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (option: PickerOption) => {
    setText(option.value);
    onChange(option.value);
    setOpen(false);
  };

  const commitText = (next: string) => {
    setText(next);
    if (allowCustom) onChange(next);
  };

  return (
    <div ref={boxRef} className={cx("relative", className)}>
      <div className="relative flex items-center">
        <input
          aria-label={ariaLabel}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            commitText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (filtered[active]) pick(filtered[active]);
              else setOpen(false);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className={cx(
            "h-9 w-full rounded-lg border bg-background-primary-default pe-8 ps-2.5 text-body-regular text-text-primary outline-none",
            open ? "border-border-focus-ring" : "border-border-button-default hover:border-border-button-hover",
            disabled && "text-text-tertiary",
          )}
        />
        <button
          type="button"
          aria-label={`展开${ariaLabel}`}
          tabIndex={-1}
          onClick={() => setOpen((v) => !v)}
          className="absolute end-1 flex size-6 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
        >
          <RiArrowDownSLine className={cx("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      </div>

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              aria-label={ariaLabel}
              style={{ position: "fixed", left: anchor.left, top: anchor.top, width: anchor.width }}
              className="z-[999] max-h-64 overflow-auto rounded-lg border border-border-button-default bg-background-primary-default p-1 shadow-xl"
            >
              {filtered.length === 0 ? (
                <p className="px-2 py-2.5 text-caption-1-regular text-text-tertiary">{emptyText}</p>
              ) : (
                filtered.map((option, index) => {
                  const selected = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(option)}
                      className={cx(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-body-2-medium",
                        index === active ? "bg-background-secondary-hover" : "",
                        selected ? "text-text-primary" : "text-text-secondary",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.value}</span>
                      {option.hint ? (
                        <span className="shrink-0 text-caption-1-regular text-text-tertiary">{option.hint}</span>
                      ) : null}
                      {selected ? <RiCheckLine className="size-3.5 shrink-0 text-text-primary" aria-hidden /> : null}
                    </button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
