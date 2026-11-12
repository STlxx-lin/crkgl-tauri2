import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";
import { cx } from "@/utils/cx";

export interface PickerOption {
  value: string;
  /** 副标题，可空 */
  hint?: string;
  /** 搜索用的额外文本（别名、简称、拼音首字母），不显示，只参与匹配 */
  search?: string;
}

/**
 * 默认匹配：包含即命中，逐字/逐词兜底。
 *
 * 只按「连续子串」比，用户打「自」时「亚德客（中国）…」这种词压根进不了候选；
 * 所以这里改成逐字打分，只在用户真的开始输入时才重排，没输入时保持后端顺序。
 */
export function fuzzyScore(text: string, keyword: string): number {
  const hay = text.toLowerCase();
  const needle = keyword.trim().toLowerCase();
  if (!needle) return 1;
  const at = hay.indexOf(needle);
  // 前缀命中排最前，其次子串命中，最后逐字命中
  if (at === 0) return 3;
  if (at > 0) return 2;
  let cursor = 0;
  for (const ch of needle.replace(/\s+/g, "")) {
    cursor = hay.indexOf(ch, cursor);
    if (cursor < 0) return 0;
    cursor += ch.length;
  }
  return 1;
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
  /**
   * 紧凑尺寸：用在表格单元格里，和同排的 h-8 输入框对齐。
   * 默认 h-9 是给表单标题栏用的。
   */
  compact?: boolean;
  /**
   * 在弹窗（react-aria Modal）里用时设成 true。
   * 弹窗有自己的焦点陷阱和「点外面关闭」判定：portal 到 body 的下拉虽然能画出来，
   * 但点击会被当成「点了遮罩」，既选不中也会把弹窗关掉。
   * inline 模式把下拉渲染成容器内的绝对定位子元素，点击留在弹窗内部就不受影响；
   * 代价是要自己处理被裁剪——所以外层的滚动容器不能有 overflow:hidden。
   */
  inline?: boolean;
  /**
   * 候选排序。默认保持传入顺序（后端已按行数排好）；
   * 给了匹配函数的场景（供应商联动）会按用户输入重排，并带缓存。
   */
  rank?: (option: PickerOption, keyword: string) => number;
  /**
   * 输入满整段名称时自动选中并退出输入，不再让用户多按一次回车。
   * 只对大小写/全半角/空格的差异放行，不做别的猜测。
   */
  autoCommitExact?: boolean;
}

/**
 * 可搜索下拉。
 *
 * 为什么不用 BoardUI 的 ComboBox：它内部的 AriaInput 在 AriaGroup 里拿不到
 * ComboBox 的值，选中后输入框仍显示占位符。这个组件自己持有文本状态。
 *
 * 两套渲染方式：
 * · 默认 portal + fixed——用于表格里的选择器，避免被 overflow 裁掉；
 * · `inline`——用于弹窗内，避开 Modal 的焦点陷阱。
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
  compact = false,
  inline = false,
  rank,
  autoCommitExact = false,
}: ComboPickerProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  // 正在输入尚未选定的关键字。非空时输入框显示它（好让用户看到自己打了什么、好继续删），
  // 收起或选中后清掉，显示回 value 的完整名称。
  const [typing, setTyping] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // portal 模式下的定位（inline 模式不用）
  const [anchor, setAnchor] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
    /** 向上展开时用 bottom 定位 */
    bottom: number | null;
  } | null>(null);

  // 外部值变化时同步输入框（例如切换单据、重置表单）。
  // 注意：自己敲字时 onChange 也会把 value 改掉，这时不能把 typing 清空，
  // 否则刚打进去的字立刻被抹掉，候选列表跟着退回全量。
  const lastTyped = useRef<string | null>(null);
  useEffect(() => {
    const isOwnTyping = lastTyped.current !== null && value === lastTyped.current;
    lastTyped.current = null;
    if (isOwnTyping) return;
    setText(value);
    setTyping("");
  }, [value]);

  const filtered = useMemo(() => {
    const keyword = typing.trim();
    if (!keyword) return options;
    // 默认用内置模糊匹配；传了 rank 的场景（供应商）用场景自己的打分
    const score = rank ?? ((o: PickerOption, k: string) => fuzzyScore(`${o.value} ${o.search ?? ""}`, k));
    const scored = options
      .map((o) => ({ o, score: score(o, keyword) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.o);
    // 打出来的字正好就是库里的某一条时，把它顶上来，回车即可收
    const low = keyword.toLowerCase();
    const exact = scored.filter((o) => o.value.trim().toLowerCase() === low);
    const out = exact.length ? [...exact, ...scored.filter((o) => !exact.includes(o))] : scored;
    return out;
  }, [typing, options, rank]);

  const measure = () => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    // 下面放不下 200px，但上面更宽裕，就往上翻
    const dropUp = below < 200 && above > below;
    const maxHeight = Math.max(120, Math.min(dropUp ? above : below, 256));
    setAnchor({
      left: r.left,
      top: dropUp ? r.top - 4 : r.bottom + 4,
      width: Math.max(r.width, 220),
      maxHeight,
      bottom: dropUp ? window.innerHeight - r.top + 4 : null,
    });
  };

  // 方向键移动 active 时，把选中项滚进下拉可视区
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const option = menu.querySelectorAll<HTMLElement>('[role="option"]')[active];
    option?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (!open || inline) return;
    measure();
    const onScroll = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, inline]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!boxRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
        setTyping("");
        setText(value);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const pick = (option: PickerOption) => {
    setText(option.value);
    setTyping("");
    onChange(option.value);
    setOpen(false);
  };

  // 用户逐字输入：值先跟着手输走（允许自定义供应商），但输入框保留关键字，
  // 免得只敲了「自」就把供应商字段整个改成「自」。
  const typeText = (next: string) => {
    setTyping(next);
    setText(next);
    if (allowCustom) {
      const committed = next.trim().length ? next : "";
      lastTyped.current = committed;
      onChange(committed);
    }
    const exact = autoCommitExact
      ? options.find((o) => o.value.trim().toLowerCase() === next.trim().toLowerCase())
      : undefined;
    if (exact) pick(exact);
  };

  const closeMenu = () => {
    setOpen(false);
    setTyping("");
    setText(value);
  };

  const list = (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={ariaLabel}
      // 弹窗里会锁 body 滚动并拦滚轮；这里自己处理一次，长列表两边都能滚
      onWheel={(event) => {
        const el = event.currentTarget;
        if (el.scrollHeight <= el.clientHeight) return;
        el.scrollTop += event.deltaY;
        event.stopPropagation();
      }}
      className={cx(
        "overflow-auto rounded-xl border border-border-button-hover bg-background-primary-default p-1 shadow-2xl ring-1 ring-black/40 dark:bg-neutral-900",
        inline
          ? // 内联：贴着输入框向下展开，层级压在弹窗内容之上
            "absolute start-0 top-full z-50 mt-1 w-full max-h-56"
          : "z-[999]",
      )}
      style={
        inline
          ? undefined
          : anchor
            ? {
                position: "fixed",
                left: anchor.left,
                ...(anchor.bottom !== null
                  ? { bottom: anchor.bottom, maxHeight: anchor.maxHeight }
                  : { top: anchor.top, maxHeight: anchor.maxHeight }),
                width: anchor.width,
              }
            : undefined
      }
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
                index === active ? "bg-dropdown-item-hover-background" : "",
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
      {typing.trim() && !filtered.some((o) => o.value.trim().toLowerCase() === typing.trim().toLowerCase()) ? (
        // 库里没有整条命中时，明确提示回车就按手输的名字新建，避免误以为选错了
        <p className="mt-1 border-t border-separator-border px-2 pt-1.5 text-caption-1-regular text-text-tertiary">
          {allowCustom ? `回车按「${typing.trim()}」新建` : "没有完全一致的项"}
        </p>
      ) : null}
    </div>
  );

  return (
    <div ref={boxRef} className={cx("relative", className)}>
      <div className="relative flex items-center">
        <input
          aria-label={ariaLabel}
          value={open && typing ? typing : text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            typeText(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // 焦点移进下拉（点候选项）时先不还原文本，等 pick 处理
            window.setTimeout(() => {
              if (menuRef.current?.matches(":hover")) return;
              setTyping("");
              setText(value);
            }, 0);
          }}
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
              // 已经手输了下拉里没有的值时，别把它换回候选项——只收起下拉。
              if (filtered[active] && filtered[active].value !== text) pick(filtered[active]);
              else closeMenu();
            } else if (e.key === "Escape") {
              closeMenu();
            }
          }}
          className={cx(
            "w-full rounded-lg border bg-background-primary-default text-text-primary placeholder:text-text-tertiary outline-none",
            compact ? "h-8 pe-6 ps-2 text-[0.8125rem]" : "h-9 pe-8 ps-2.5 text-body-regular",
            open ? "border-border-focus-ring" : "border-border-button-default hover:border-border-button-hover",
            disabled && "text-text-tertiary",
          )}
        />
        <button
          type="button"
          aria-label={`展开${ariaLabel}`}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) closeMenu();
            else setOpen(true);
          }}
          className={cx(
            "absolute flex items-center justify-center rounded text-text-tertiary hover:text-text-primary",
            compact ? "end-0.5 size-5" : "end-1 size-6",
          )}
        >
          <RiArrowDownSLine className={cx("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      </div>

      {open
        ? inline
          ? list
          : anchor
            ? createPortal(list, document.body)
            : null
        : null}
    </div>
  );
}
