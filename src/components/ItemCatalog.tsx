import { useEffect, useState } from "react";
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
}: {
  /** 用哪个词筛：一般传左边正在输入的编码或名称 */
  keyword?: string;
  /** 顶部提示条，例如「这个编码已经建过档」 */
  hint?: string | null;
  className?: string;
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
        <span className="whitespace-nowrap text-caption-1-semibold text-text-tertiary">
          基础资料里的物料
        </span>
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
        {rows.map((row) => (
          <li
            key={row.id}
            title={`${row.itemCode} ${row.itemName}`}
            className="flex w-full cursor-default items-center gap-2 overflow-hidden rounded-md px-2 py-1.5"
          >
            <span className="shrink-0 whitespace-nowrap font-mono text-[0.6875rem] text-text-tertiary">
              {row.itemCode}
            </span>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-body-2-medium text-text-primary">
              {row.itemName}
            </span>
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
          </li>
        ))}
        {rows.length === 0 && !loading ? (
          <li className="px-2 py-3 text-center text-caption-1-regular text-text-tertiary">
            {matched ? "基础资料里没有匹配的物料，保存就是新建" : "基础资料里还没有物料"}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
