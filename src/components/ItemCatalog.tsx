import { useEffect, useState } from "react";
import { RiEditLine } from "@remixicon/react";
import { isTauri, listItems } from "../lib/api";
import { priceText } from "../lib/format";
import type { Item } from "../lib/types";

/**
 * 基础资料物料对照清单（只读）。
 *
 * 新增物料时右边摆一份现有物料：一是避免建重，二是照着已有写法把名称、单位对齐。
 * 只做展示，不给点击——录单页的候选已经有下拉了，这里点一下就填反而容易误触。
 *
 * 关键字跟着左边的编码/名称实时筛，按建档时间倒序（刚建的排最前）。
 */
export function ItemCatalog({
  keyword,
  hint,
  className,
  onSelect,
  selectedId,
}: {
  /** 用哪个词筛：一般传左边正在输入的编码或名称 */
  keyword?: string;
  /** 顶部提示条，例如「这个编码已经建过档」 */
  hint?: string | null;
  className?: string;
  /** 点击某一行物料时的回调，用于载入编辑 */
  onSelect?: (item: Item) => void;
  /** 当前正在编辑的物料 ID，用于高亮 */
  selectedId?: number | null;
}) {
  const [rows, setRows] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [matched, setMatched] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    setLoading(true);
    const text = (keyword ?? "").trim() || undefined;
    setMatched(Boolean(text));
    const timer = window.setTimeout(() => {
      listItems({ keyword: text, onlyActive: true, limit: 60, recent: true })
        .then((list) => {
          if (alive) setRows(list);
        })
        .catch(() => {
          if (alive) setRows([]);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [keyword]);

  return (
    <div
      className={
        "flex min-w-0 flex-col rounded-xl border border-separator-border bg-background-secondary-default " +
        (className ?? "")
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-separator-border px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="whitespace-nowrap text-caption-1-semibold text-text-tertiary">
            基础资料里的物料
          </span>
          {onSelect ? (
            <span className="text-[0.6875rem] text-text-brand">（点击编辑）</span>
          ) : null}
        </div>
        <span className="shrink-0 whitespace-nowrap text-caption-1-regular text-text-tertiary">
          {loading ? "查询中…" : `${rows.length} 条`}
        </span>
      </div>

      {hint ? (
        <p className="border-b border-emerald-500/25 bg-emerald-500/6 px-3 py-1.5 text-caption-1-regular text-emerald-500">
          {hint}
        </p>
      ) : null}

      <ul className="max-h-[22rem] flex-1 select-text overflow-y-auto p-1" aria-label="基础资料物料（只读对照）">
        {rows.map((row) => {
          const isSelected = selectedId === row.id;
          return (
            <li
              key={row.id}
              title={`${row.itemCode} ${row.itemName}${row.spec ? ` (${row.spec})` : ""}${
                onSelect ? " · 点击载入编辑" : ""
              }`}
              onClick={() => onSelect?.(row)}
              className={
                "group flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 transition-colors " +
                (onSelect ? "cursor-pointer hover:bg-background-secondary-hover " : "cursor-default ") +
                (isSelected ? "bg-background-tertiary-default ring-1 ring-border-focus-ring" : "")
              }
            >
              <span className="shrink-0 whitespace-nowrap font-mono text-[0.6875rem] text-text-tertiary group-hover:text-text-secondary">
                {row.itemCode}
              </span>
              <span className="min-w-0 flex-1 truncate whitespace-nowrap text-body-2-medium text-text-primary">
                {row.itemName}
              </span>
              {row.spec ? (
                <span className="shrink-0 max-w-[7rem] truncate font-mono text-[0.6875rem] text-text-tertiary" title={row.spec}>
                  {row.spec}
                </span>
              ) : null}
              {row.unit ? (
                <span className="shrink-0 whitespace-nowrap text-caption-1-regular text-text-tertiary">
                  {row.unit}
                </span>
              ) : null}
              {row.priceMicros != null ? (
                <span className="shrink-0 whitespace-nowrap font-mono text-caption-1-regular tabular-nums text-text-tertiary">
                  ¥{priceText(row.priceMicros)}
                </span>
              ) : null}
              {onSelect ? (
                <span
                  className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-text-brand"
                  title="编辑此物料"
                >
                  <RiEditLine className="size-3.5" />
                </span>
              ) : null}
            </li>
          );
        })}
        {rows.length === 0 && !loading ? (
          <li className="px-2 py-3 text-center text-caption-1-regular text-text-tertiary">
            {matched ? "基础资料里没有匹配的物料，保存就是新建" : "基础资料里还没有物料"}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
