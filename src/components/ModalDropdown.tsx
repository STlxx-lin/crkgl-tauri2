import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";

export interface ModalDropdownProps {
  /** 用于 aria 标签与列表 id（单位、类型、类别等） */
  label: string;
  placeholder?: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  className?: string;
}

/**
 * 专为弹窗（Modal）优化的可输入下拉选择器。
 *
 * 核心设计：
 * 1. 下拉面板通过 createPortal 挂在弹窗容器（role="dialog"）根节点下，
 *    完全脱离 ModalBody 的 overflow-y-auto 滚动裁剪区，同时仍处在 Modal DOM 树内部
 *    （避免触发 react-aria 的点击外部关闭弹窗）；
 * 2. 智能朝向判定（dropUp）：当输入框下方距离窗口/弹窗底部不足以容纳列表时，
 *    自动向上翻转展开，彻底根除底部被截断看不全的问题；
 * 3. 键盘与输入完全闭环：输入即过滤、↑↓ 高亮移动、Enter 选中、Esc 仅关闭下拉、可直接输入自定义新值。
 */
export function ModalDropdown({
  label,
  placeholder,
  value,
  options,
  onChange,
  className,
}: ModalDropdownProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [active, setActive] = useState(0);
  const [typing, setTyping] = useState(false);
  const [, setTick] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 外部值变化时同步输入框
  useEffect(() => {
    setText((prev) => (prev === value ? prev : value));
    setTyping((prev) => (prev && text === value ? prev : false));
  }, [value]);

  // 打字中按包含关系筛；没在打字（刚聚焦、刚选中）就列全部
  const filtered = useMemo(() => {
    const keyword = typing ? text.trim() : "";
    if (!keyword) return options;
    return options.filter((c) => c.toLowerCase().includes(keyword.toLowerCase()));
  }, [typing, text, options]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.querySelectorAll<HTMLElement>("[role='option']")[active];
    item?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // 弹窗内部滚动或窗口缩放时重算浮层坐标
  useEffect(() => {
    if (!open) return;
    const relayout = () => setTick((n) => n + 1);
    window.addEventListener("scroll", relayout, true);
    window.addEventListener("resize", relayout);
    return () => {
      window.removeEventListener("scroll", relayout, true);
      window.removeEventListener("resize", relayout);
    };
  }, [open]);

  // 点击边框外部收起下拉框
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (!wrapRef.current?.contains(target) && !listRef.current?.contains(target)) {
        setOpen(false);
        setTyping(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  // 下拉展开时，Esc 只收下拉，不能连带关掉整个弹窗
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      setTyping(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const pick = (next: string) => {
    setText(next);
    onChange(next);
    setTyping(false);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (filtered[active] !== undefined) pick(filtered[active]);
      else setOpen(false);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setTyping(false);
    } else if (e.key === "Tab" && open) {
      setOpen(false);
      setTyping(false);
    }
  };

  const el = open ? wrapRef.current : null;
  const host = el
    ? ((el.closest('[role="dialog"]')?.parentElement ?? el.closest('[role="dialog"]')) as HTMLElement | null)
    : null;
  const rect = el ? el.getBoundingClientRect() : null;
  const hostRect = host ? host.getBoundingClientRect() : null;
  // 下方空间不足 210px 且上方更宽裕时，智能向上展开
  const dropUp = rect ? window.innerHeight - rect.bottom - 16 < 210 && rect.top > window.innerHeight - rect.bottom : false;

  const listbox = open ? (
    <ul
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={`${label}选项`}
      onWheel={(event) => {
        const node = event.currentTarget;
        if (node.scrollHeight <= node.clientHeight) return;
        node.scrollTop += event.deltaY;
        event.stopPropagation();
      }}
      style={
        rect && hostRect
          ? {
              position: "absolute",
              left: rect.left - hostRect.left,
              width: rect.width,
              ...(dropUp
                ? { bottom: hostRect.bottom - rect.top + 4 }
                : { top: rect.bottom - hostRect.top + 4 }),
            }
          : undefined
      }
      className={
        "z-50 max-h-52 overflow-y-auto rounded-xl border border-border-button-hover bg-background-primary-default p-1 shadow-2xl ring-1 ring-black/40 dark:bg-neutral-900 " +
        (rect && hostRect ? "" : "absolute inset-x-0 " + (dropUp ? "bottom-full mb-1" : "top-full mt-1"))
      }
    >
      {filtered.length === 0 ? (
        <li className="px-2.5 py-2 text-caption-1-regular text-text-tertiary">
          没有匹配的{label}，回车或直接保存即可使用「{text.trim()}」
        </li>
      ) : (
        filtered.map((c, index) => {
          const selected = c === value;
          const highlighted = index === active;
          return (
            <li
              key={c}
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              className={
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-body-2-medium transition-colors " +
                (highlighted ? "bg-dropdown-item-hover-background " : "") +
                (selected ? "text-text-primary" : "text-text-secondary")
              }
            >
              <span className="truncate">{c}</span>
              {selected ? <RiCheckLine className="size-3.5 shrink-0 text-text-primary" aria-hidden /> : null}
            </li>
          );
        })
      )}
    </ul>
  ) : null;

  return (
    <div ref={wrapRef} className={"relative " + (className ?? "") + (open ? " z-40" : "")}>
      <div className="relative">
        <input
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          value={text}
          placeholder={placeholder ?? `选或输入新${label}`}
          onChange={(e) => {
            setText(e.target.value);
            onChange(e.target.value);
            setActive(0);
            setTyping(true);
            setOpen(true);
          }}
          onFocus={() => {
            setTyping(false);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={
            "h-9 w-full rounded-lg border bg-background-primary-default ps-2.5 pe-8 text-body-regular text-text-primary outline-none placeholder:text-text-tertiary " +
            (open
              ? "border-border-focus-ring ring-2 ring-border-focus-ring/20"
              : "border-border-button-default hover:border-border-button-hover")
          }
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={`展开${label}列表`}
          onClick={() => setOpen((v) => !v)}
          className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
        >
          <RiArrowDownSLine className={"size-4 transition-transform " + (open ? "rotate-180" : "")} aria-hidden />
        </button>
      </div>

      {listbox ? (host ? createPortal(listbox, host) : listbox) : null}
    </div>
  );
}
