import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RiArrowDownSLine, RiSearchLine } from "@remixicon/react";
import { cx } from "@/utils/cx";
import { listItems } from "../lib/api";
import type { Item } from "../lib/types";
import { priceText } from "../lib/format";

interface ItemPickerProps {
  value: string;
  onPick: (item: Item) => void;
  onChangeText: (text: string) => void;
  onBlurClose?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * 物料编码选择器。
 *
 * 不用原生 <datalist>：4,000 多条物料全塞进去既慢又没法按名称搜，
 * 还会混出 `-`、`0` 这种粘贴残留。这里改成输入即查后端，
 * 最多列 30 条，带名称/单位/参考单价，键盘上下可选。
 */
export function ItemPicker({
  value,
  onPick,
  onChangeText,
  onBlurClose,
  disabled,
  placeholder = "编码或名称",
}: ItemPickerProps) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // 下拉已经 portal 到 body，不在 boxRef 里，必须单独判断是否点了它
  const menuRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  // 表格容器是 overflow-x-auto，绝对定位的下拉会被裁掉，
  // 所以改用 fixed 定位渲染到 body。
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);

  const measure = () => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 320) });
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

  // 输入防抖后再查，避免每敲一个字都打一次后端
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(async () => {
      const ticket = ++seq.current;
      setLoading(true);
      try {
        const list = await listItems({ keyword: keyword.trim() || undefined, onlyActive: true, limit: 30 });
        if (ticket === seq.current) {
          setItems(list);
          setActive(0);
        }
      } catch {
        if (ticket === seq.current) setItems([]);
      } finally {
        if (ticket === seq.current) setLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [keyword, open]);

  // 点外面收起
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const inField = boxRef.current?.contains(target) ?? false;
      const inMenu = menuRef.current?.contains(target) ?? false;
      if (!inField && !inMenu) {
        setOpen(false);
        onBlurClose?.();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onBlurClose]);

  // 打开时显示正在输入的搜索词；收起时只显示编码（名称有单独一列）
  const display = useMemo(() => (open ? keyword : value), [open, keyword, value]);

  const pick = (item: Item) => {
    onPick(item);
    setOpen(false);
    setKeyword("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (items[active]) pick(items[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="relative flex items-center">
        <input
          value={display ?? ""}
          onChange={(e) => {
            onChangeText(e.target.value);
            setKeyword(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          className={cx(
            "h-8 w-full rounded-md border bg-transparent pe-6 ps-1.5 text-[12px] text-text-primary outline-none",
            open ? "border-border-focus-ring" : "border-transparent hover:border-border-button-default",
            disabled && "text-text-tertiary",
          )}
        />
        <button
          type="button"
          aria-label="选择物料"
          tabIndex={-1}
          onClick={() => setOpen((v) => !v)}
          className="absolute end-0.5 flex size-6 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
        >
          <RiArrowDownSLine className="size-3.5" aria-hidden />
        </button>
      </div>

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              style={{ position: "fixed", left: anchor.left, top: anchor.top, width: anchor.width }}
              className="z-[999] max-h-72 overflow-auto rounded-lg border border-border-button-default bg-background-primary-default p-1 shadow-xl"
            >
              <div className="sticky top-0 mb-1 flex items-center gap-1.5 rounded-md bg-background-secondary-default px-2 py-1 text-caption-1-regular text-text-tertiary">
                <RiSearchLine className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                  {keyword.trim() ? `匹配「${keyword.trim()}」` : "输入编码或名称过滤"}
                </span>
                {loading ? <span className="ms-auto shrink-0">查询中</span> : null}
              </div>
              {items.length === 0 && !loading ? (
                <p className="px-2 py-3 text-center text-caption-1-regular text-text-tertiary">没有匹配的物料</p>
              ) : (
                <ul role="listbox" aria-label="物料候选">
                  {items.map((item, index) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === active}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => pick(item)}
                        className={cx(
                          "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start",
                          index === active ? "bg-background-secondary-hover" : "",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-text-tertiary">{item.itemCode}</span>
                          <span className="truncate text-body-2-medium text-text-primary">{item.itemName}</span>
                        </span>
                        <span className="flex items-center gap-2 text-caption-1-regular text-text-tertiary">
                          {item.category ? <span>{item.category}</span> : null}
                          {item.unit ? <span>{item.unit}</span> : null}
                          {item.priceMicros !== null ? (
                            <span className="ms-auto font-mono tabular-nums">¥{priceText(item.priceMicros)}</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
