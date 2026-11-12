import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RiArrowDownSLine, RiSearchLine } from "@remixicon/react";
import { cx } from "@/utils/cx";
import { fetchItemMaster, listItems } from "../lib/api";
import type { Item, ItemMaster } from "../lib/types";
import { priceText } from "../lib/format";

interface ItemPickerProps {
  value: string;
  onPick: (item: Item) => void;
  onChangeText: (text: string) => void;
  onBlurClose?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /**
   * 候选来源：
   * · "inbound"（默认）只列真正入库过的物料——开单页的物料编码要引用已入库数据
   * · "master" 列基础资料里的全部物料（含还没入库过的）
   */
  source?: "inbound" | "master";
  /** 只看还有库存的物料（出库单用） */
  inStockOnly?: boolean;
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
  source = "inbound",
  inStockOnly = false,
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
  // 表格容器是 overflow-x-auto，绝对定位的下拉会被裁掉，所以默认 fixed 渲染到 body；
  // 但在弹窗（react-aria Modal）内部时，如果 portal 到 body，点击下拉项会被 Modal 当成点到弹窗外部而直接关掉弹窗，
  // 所以弹窗内挂到 dialog 宿主节点并使用相对它的绝对定位。
  const [anchor, setAnchor] = useState<{
    left: number;
    top: number;
    width: number;
    host: HTMLElement | null;
  } | null>(null);

  const measure = () => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dialog = el.closest('[role="dialog"]');
    const host = (dialog?.parentElement ?? dialog) as HTMLElement | null;
    if (host) {
      const hr = host.getBoundingClientRect();
      setAnchor({
        left: r.left - hr.left,
        top: r.bottom - hr.top + 4,
        width: Math.max(r.width, 320),
        host,
      });
    } else {
      setAnchor({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 320), host: null });
    }
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
        const list =
          source === "inbound"
            ? inboundToItems(await fetchItemMaster(keyword.trim() || undefined, 30, true, inStockOnly))
            : await listItems({ keyword: keyword.trim() || undefined, onlyActive: true, limit: 30 });
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
  }, [keyword, open, source, inStockOnly]);

  // 点外面收起（用捕获阶段，避免被弹窗内部 stopPropagation 吞掉）
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
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, onBlurClose]);

  // 打开时显示正在输入的搜索词；收起时显示当前列的值（编码列显示编码，名称列显示名称）
  const display = useMemo(() => (open ? keyword : value), [open, keyword, value]);

  const pick = (item: Item) => {
    onPick(item);
    setOpen(false);
    setKeyword("");
  };

  // 方向键移动 active 时，把选中项滚进可视区（弹窗里原生 scrollIntoView 也能用）
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const option = menu.querySelectorAll<HTMLElement>('[role="option"]')[active];
    option?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

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
            "h-8 w-full rounded-md border pe-6 ps-1.5 text-[0.75rem] text-text-primary placeholder:text-text-tertiary outline-none",
            open
              ? "border-border-focus-ring bg-background-primary-default"
              : "border-border-button-default bg-background-secondary-default hover:border-border-button-hover",
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
              style={{
                position: anchor.host ? "absolute" : "fixed",
                left: anchor.left,
                top: anchor.top,
                width: anchor.width,
              }}
              // 弹窗（react-aria Modal）会给 body 加 overflow:hidden 并拦滚轮，
              // 这里自己处理一次，让候选列表在弹窗里也能顺畅滚动。
              onWheel={(event) => {
                const el = event.currentTarget;
                if (el.scrollHeight <= el.clientHeight) return;
                el.scrollTop += event.deltaY;
                event.stopPropagation();
              }}
              className="z-[999] max-h-72 overflow-auto rounded-lg border border-border-button-hover bg-background-primary-default p-1 shadow-2xl ring-1 ring-black/40 dark:bg-neutral-900"
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
                          index === active ? "bg-dropdown-item-hover-background" : "",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[0.6875rem] text-text-tertiary">{item.itemCode}</span>
                          <span className="truncate text-body-2-medium text-text-primary">{item.itemName}</span>
                        </span>
                        <span className="flex items-center gap-2 text-caption-1-regular text-text-tertiary">
                          {item.category ? <span>{item.category}</span> : null}
                          {item.unit ? <span>{item.unit}</span> : null}
                          {item.stockQty !== null && item.stockQty !== undefined ? (
                            <span
                              className={
                                item.stockQty > 0
                                  ? "rounded bg-emerald-500/12 px-1 py-0.5 font-mono tabular-nums text-emerald-500"
                                  : "rounded bg-amber-500/12 px-1 py-0.5 font-mono tabular-nums text-amber-500"
                              }
                            >
                              库存 {formatStock(item.stockQty)}
                            </span>
                          ) : null}
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
            anchor.host ?? document.body,
          )
        : null}
    </div>
  );
}

/** 后端聚合结果 → 选择器用的 Item 形状（单价字段名不同，这里转一次）。 */
function inboundToItems(rows: ItemMaster[]): Item[] {
  return rows.map((row, index) => ({
    id: -(index + 1),
    itemCode: row.itemCode,
    itemName: row.itemName,
    category: null,
    unit: row.unit,
    priceMicros: row.lastPriceMicros,
    spec: null,
    itemType: null,
    drawingNo: null,
    owner: null,
    supplier: null,
    remark: null,
    location: null,
    active: true,
    stockQty: row.stockQty,
  }));
}
/** 库存量：去掉无意义的尾零，最多三位小数。 */
function formatStock(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value);
}
