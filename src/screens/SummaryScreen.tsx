import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowDownLine, RiArrowUpLine, RiEqualLine, RiRefreshLine } from "@remixicon/react";
import { fetchSummary } from "../lib/api";
import type { GroupRow, LedgerFilter, SummaryBundle, TopItem } from "../lib/types";
import { count, delta, money, moneyCompact, qty } from "../lib/format";
import { Button } from "@/components/base/buttons/button";
import { Select, SelectItem } from "@/components/base/select/select";
import { Switch } from "@/components/base/switch/switch";
import { Spinner } from "@/components/base/spinner/spinner";
import { toast } from "@/components/base/toast/toast";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";

const RANGES = [
  { id: "all", label: "全部时间" },
  { id: "thisYear", label: "本年" },
  { id: "lastYear", label: "去年" },
  { id: "thisQuarter", label: "本季度" },
] as const;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function iso(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rangeFor(id: string): { from: string | null; to: string | null } {
  const now = new Date();
  if (id === "thisYear") return { from: `${now.getFullYear()}-01-01`, to: iso(now) };
  if (id === "lastYear") return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` };
  if (id === "thisQuarter") {
    const quarterStart = Math.floor(now.getMonth() / 3) * 3;
    return { from: iso(new Date(now.getFullYear(), quarterStart, 1)), to: iso(now) };
  }
  return { from: null, to: null };
}

/**
 * 汇总页。方向上只认一件事：这是仓库的账，
 * 所以整页只留一个强调色（出库=消耗），入库用中性刻度，图表里两条柱一眼分得开。
 */
export function SummaryScreen({ boot }: { boot: { minDate: string | null; maxDate: string | null } | null }) {
  const [rangeId, setRangeId] = useState<string>(boot?.minDate && boot.maxDate ? "all" : "thisYear");
  const [data, setData] = useState<SummaryBundle | null>(null);
  const [loading, setLoading] = useState(false);
  // 合并看全部仓库：只有汇总页支持，台账/库存/导出都严格单仓
  const [mergeAll, setMergeAll] = useState(false);
  const seq = useRef(0);

  const filter = useMemo<LedgerFilter>(() => {
    const { from, to } = rangeFor(rangeId);
    return { from, to, sort: "date", desc: true };
  }, [rangeId]);

  const load = useCallback(async () => {
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const bundle = await fetchSummary(filter, mergeAll);
      if (ticket === seq.current) setData(bundle);
    } catch (err) {
      toast("汇总读取失败", { description: String(err), status: "error" });
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [filter, mergeAll]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = data?.totals;
  const cmp = data?.compare ?? null;
  // 出库明细没有金额列时，主口径自动落到入库，避免整页显示 0.00
  const primary: "in" | "out" =
    (totals?.amountOutCents ?? 0) > 0 && (totals?.amountOutCents ?? 0) >= (totals?.amountInCents ?? 0) * 0.1 ? "out" : "in";

  const spans = [
    {
      label: "入库金额",
      value: totals?.amountInCents ?? 0,
      previous: cmp?.previous.amountInCents,
      sub: `入库数量 ${qty(totals?.qtyIn ?? 0)}`,
      tone: "neutral" as const,
    },
    {
      label: "出库金额",
      value: totals?.amountOutCents ?? 0,
      previous: cmp?.previous.amountOutCents,
      sub: `出库数量 ${qty(totals?.qtyOut ?? 0)}`,
      tone: "accent" as const,
    },
    {
      label: "净入库",
      value: (totals?.amountInCents ?? 0) - (totals?.amountOutCents ?? 0),
      previous: cmp ? cmp.previous.amountInCents - cmp.previous.amountOutCents : undefined,
      sub: `${count(totals?.inRows ?? 0)} 张入库行 / ${count(totals?.outRows ?? 0)} 张出库行`,
      tone: "neutral" as const,
    },
    {
      label: "涉及物料",
      value: totals?.itemCount ?? 0,
      previous: undefined,
      sub: `${count(totals?.docCount ?? 0)} 张单据`,
      tone: "neutral" as const,
      isCount: true,
    },
  ];

  return (
    <>
      <PageHeader
        title="汇总"
        description={
          mergeAll
            ? "合并显示全部仓库，只用于看总量；台账、库存、导出仍然按单个仓库"
            : "按筛选期统计入库与出库；环比对比的是等长的上一期"
        }
        actions={
          <>
            <Switch
              size="sm"
              isSelected={mergeAll}
              onChange={setMergeAll}
              aria-label="合并全部仓库（只用于查看，不可导出）"
            >
              全部仓库
            </Switch>
            <Select
              aria-label="统计区间"
              size="sm"
              selectedKey={rangeId}
              onSelectionChange={(key) => setRangeId(String(key))}
              className="w-32"
            >
              {RANGES.map((range) => (
                <SelectItem key={range.id} id={range.id}>
                  {range.label}
                </SelectItem>
              ))}
            </Select>
            <Button size="small" variant="secondary" leadingIcon={RiRefreshLine} onClick={load} disabled={loading}>
              刷新
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!data && loading ? (
          <div className="flex h-64 items-center justify-center gap-2 text-body-2-regular text-text-tertiary">
            <Spinner size="sm" aria-label="加载中" /> 正在统计
          </div>
        ) : !totals || totals.rows === 0 ? (
          <div className="flex h-64 items-center justify-center">
            <EmptyState title="这个区间没有数据" description="换一个统计区间，或先去「导入」页导入明细。" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* 四个数字：左二是强调位（出库），其余走中性刻度 */}
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {spans.map((span) => (
                <StatCard key={span.label} span={span} compareLabel={cmp?.previousLabel} />
              ))}
            </section>

            <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <MonthlyChart points={data?.monthly ?? []} primary={primary} />
              <TopList items={primary === "out" ? data?.topOut ?? [] : data?.topIn ?? []} title={primary === "out" ? "出库金额前 10 物料" : "入库金额前 10 物料"} kindLabel={primary === "out" ? "出库" : "入库"} />
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <GroupTable rows={data?.byOwner ?? []} title="按归属" empty="出库明细里的归属列是空的" />
              <GroupTable rows={data?.byPartner ?? []} title="按供应商" empty="没有供应商信息" />
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <TopList items={data?.topIn ?? []} title="入库金额前 10 物料" kindLabel="入库" variant="neutral" />
              <MonthTable points={data?.monthly ?? []} />
            </section>
          </div>
        )}
      </div>
    </>
  );
}

function StatCard({
  span,
  compareLabel,
}: {
  span: {
    label: string;
    value: number;
    previous?: number;
    sub: string;
    tone: "neutral" | "accent";
    isCount?: boolean;
  };
  compareLabel?: string;
}) {
  const change = span.previous === undefined ? null : delta(span.value, span.previous);
  const accent = span.tone === "accent";
  return (
    <div
      className={
        "rounded-2xl border px-4 py-4 " +
        (accent
          ? "border-border-button-default bg-background-primary-default"
          : "border-separator-border bg-background-primary-default")
      }
    >
      <p className="text-caption-1-semibold text-text-tertiary">{span.label}</p>
      <p
        className={
          "mt-1.5 font-mono text-[1.625rem] font-medium leading-8 tabular-nums " +
          (accent ? "text-text-primary" : "text-text-primary")
        }
      >
        {span.isCount ? count(span.value) : money(span.value)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-caption-1-regular text-text-tertiary">{span.sub}</span>
        {change ? (
          <span
            className="inline-flex items-center gap-0.5 text-caption-1-semibold text-text-secondary"
            title={compareLabel ? `对比 ${compareLabel}` : undefined}
          >
            {change.direction === "up" ? (
              <RiArrowUpLine className="size-3" aria-hidden />
            ) : change.direction === "down" ? (
              <RiArrowDownLine className="size-3" aria-hidden />
            ) : (
              <RiEqualLine className="size-3" aria-hidden />
            )}
            {change.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 月度对比：入库为中性刻度，出库为强调色；悬停给出当月数值。 */
/** 月度对比：主口径用强调色，另一条用中性刻度；没有数据的月份标出来。 */
function MonthlyChart({
  points,
  primary,
}: {
  points: SummaryBundle["monthly"];
  primary: "in" | "out";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const recent = points.slice(-12);
  const primaryKey = primary === "out" ? "amountOutCents" : "amountInCents";
  const secondaryKey = primary === "out" ? "amountInCents" : "amountOutCents";
  // 另一条全为 0 时按单条缩放，避免两条同样的柱子挤在一起看不出来
  const secondaryMax = Math.max(0, ...recent.map((point) => point[secondaryKey]));
  const primaryMax = Math.max(0, ...recent.map((point) => point[primaryKey]));
  const bothZero = secondaryMax === 0 && primaryMax === 0;
  const max = Math.max(1, secondaryMax === 0 ? primaryMax : Math.max(primaryMax, secondaryMax));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => Math.round(max * ratio));
  const primaryLabel = primary === "out" ? "出库" : "入库";
  const secondaryLabel = primary === "out" ? "入库" : "出库";
  const emptyMonths = recent.filter((point) => point.amountInCents === 0 && point.amountOutCents === 0).length;

  return (
    <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-title-4-semibold text-text-primary">按月金额</h2>
          <p className="mt-0.5 text-caption-1-regular text-text-tertiary">
            最近 {recent.length} 个月 · 左条{secondaryLabel}、右条{primaryLabel}
            {secondaryMax === 0 && primaryMax > 0 ? ` · ${secondaryLabel}没有金额` : ""}
            {emptyMonths > 0 ? ` · 其中 ${emptyMonths} 个月没有数据` : ""}
            {bothZero ? " · 这个区间没有金额数据" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 text-caption-1-semibold text-text-tertiary">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-sm bg-accent-500" /> {primaryLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-sm bg-text-quaternary/60" /> {secondaryLabel}
          </span>
        </div>
      </div>

      <div className="mt-5 flex gap-3">
        {/* Y 轴刻度 */}
        <div className="flex w-14 shrink-0 flex-col justify-between pb-7 text-end font-mono text-[0.6875rem] tabular-nums text-text-tertiary">
          {ticks.map((tick, index) => (
            <span key={index}>{moneyCompact(tick)}</span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 bottom-7 flex flex-col justify-between">
            {ticks.map((_tick, index) => (
              <span key={index} className="h-px w-full bg-separator-border" />
            ))}
          </div>

          <div className="relative flex items-stretch gap-2" style={{ height: 224 }}>
            {recent.map((point, index) => {
              const primaryH = (point[primaryKey] / max) * 100;
              const secondaryH = (point[secondaryKey] / max) * 100;
              const active = hover === index;
              const width = secondaryMax === 0 ? "w-3/5" : "w-1/2";
              return (
                <div
                  key={point.month}
                  className="group relative flex min-w-0 flex-1 items-end justify-center gap-[3px] self-stretch"
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className={"max-w-6 rounded-t-[3px] bg-text-quaternary/45 transition-colors group-hover:bg-text-quaternary/70 " + width}
                    style={{ height: `${Math.max(secondaryH, 0.6)}%` }}
                  />
                  <div
                    className={"max-w-6 rounded-t-[3px] bg-accent-500 transition-colors group-hover:bg-accent-400 " + width}
                    style={{ height: `${Math.max(primaryH, 0.6)}%` }}
                  />
                  {active ? (
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-44 -translate-x-1/2 rounded-lg border border-separator-border bg-background-primary-default p-2.5 shadow-lg">
                      <p className="font-mono text-caption-1-semibold tabular-nums text-text-primary">{point.month}</p>
                      <p className="mt-1 flex justify-between gap-2 text-caption-1-regular">
                        <span className="text-text-tertiary">{primaryLabel}</span>
                        <span className="font-mono tabular-nums text-text-primary">{money(point[primaryKey])}</span>
                      </p>
                      <p className="flex justify-between gap-2 text-caption-1-regular">
                        <span className="text-text-tertiary">{secondaryLabel}</span>
                        <span className="font-mono tabular-nums text-text-secondary">{money(point[secondaryKey])}</span>
                      </p>
                      <p className="mt-1 flex justify-between gap-2 border-t border-separator-border pt-1 text-caption-1-regular">
                        <span className="text-text-tertiary">行数</span>
                        <span className="font-mono tabular-nums text-text-secondary">
                          {count(point.inRows)} / {count(point.outRows)}
                        </span>
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="mt-2 flex gap-2">
            {recent.map((point, index) => (
              <span
                key={point.month}
                className="min-w-0 flex-1 text-center font-mono text-[0.6875rem] tabular-nums text-text-tertiary"
              >
                {recent.length <= 8 || index % 2 === 0 ? point.month.slice(2).replace("-", "/") : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TopList({
  items,
  title,
  kindLabel,
  variant = "accent",
}: {
  items: TopItem[];
  title: string;
  kindLabel: string;
  variant?: "accent" | "neutral";
}) {
  const max = Math.max(1, ...items.map((item) => item.amountCents));
  return (
    <div className="flex flex-col rounded-2xl border border-border-button-default bg-background-primary-default p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-title-4-semibold text-text-primary">{title}</h2>
        <span className="text-caption-1-regular text-text-tertiary">{kindLabel}金额</span>
      </div>
      {items.length === 0 ? (
        <p className="py-10 text-center text-body-2-regular text-text-tertiary">没有数据</p>
      ) : (
        <ol className="mt-3 flex flex-col">
          {items.map((item, index) => (
            <li key={(item.itemCode ?? "") + (item.itemName ?? "") + index} className="flex items-center gap-2 py-[5px]">
              <span className="w-4 shrink-0 font-mono text-[0.6875rem] tabular-nums text-text-tertiary">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-body-2-medium text-text-primary" title={item.itemName ?? ""}>
                    {item.itemName ?? item.itemCode ?? "未命名"}
                  </span>
                  <span className="shrink-0 font-mono text-body-2-medium tabular-nums text-text-secondary">
                    {money(item.amountCents)}
                  </span>
                </div>
                <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-background-secondary-default">
                  <div
                    className={"h-full rounded-full " + (variant === "accent" ? "bg-accent-500" : "bg-text-quaternary")}
                    style={{ width: `${Math.max(2, (item.amountCents / max) * 100)}%` }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function GroupTable({ rows, title, empty }: { rows: GroupRow[]; title: string; empty: string }) {
  const max = Math.max(1, ...rows.map((row) => Math.max(row.amountInCents, row.amountOutCents)));
  return (
    <div className="flex flex-col rounded-2xl border border-border-button-default bg-background-primary-default">
      <div className="flex items-baseline justify-between gap-2 px-5 pb-3 pt-4">
        <h2 className="text-title-4-semibold text-text-primary">{title}</h2>
        <span className="text-caption-1-regular text-text-tertiary">按出库金额排序</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pb-8 pt-2 text-body-2-regular text-text-tertiary">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.8125rem]">
            <thead>
              <tr className="border-y border-separator-border text-caption-1-semibold text-text-tertiary">
                <th className="px-5 py-2 text-start font-medium">名称</th>
                <th className="w-28 px-3 py-2 text-end font-medium">入库</th>
                <th className="w-28 px-3 py-2 text-end font-medium">出库</th>
                <th className="w-40 px-5 py-2 text-start font-medium">出库占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-separator-border last:border-0">
                  <td className="max-w-[220px] truncate px-5 py-2 text-text-primary" title={row.key}>
                    {row.key || "未标注"}
                  </td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums text-text-tertiary">
                    {row.amountInCents ? money(row.amountInCents) : "—"}
                  </td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums text-text-primary">
                    {row.amountOutCents ? money(row.amountOutCents) : "—"}
                  </td>
                  <td className="px-5 py-2">
                    <div className="h-[3px] w-full overflow-hidden rounded-full bg-background-secondary-default">
                      <div
                        className="h-full rounded-full bg-accent-500"
                        style={{ width: `${Math.max(1, (row.amountOutCents / max) * 100)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MonthTable({ points }: { points: SummaryBundle["monthly"] }) {
  const recent = [...points].reverse().slice(0, 12);
  return (
    <div className="flex flex-col rounded-2xl border border-border-button-default bg-background-primary-default">
      <div className="flex items-baseline justify-between gap-2 px-5 pb-3 pt-4">
        <h2 className="text-title-4-semibold text-text-primary">逐月明细</h2>
        <span className="text-caption-1-regular text-text-tertiary">最近 12 个月</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[0.8125rem]">
          <thead>
            <tr className="border-y border-separator-border text-caption-1-semibold text-text-tertiary">
              <th className="px-5 py-2 text-start font-medium">月份</th>
              <th className="w-24 px-3 py-2 text-end font-medium">入库行</th>
              <th className="w-32 px-3 py-2 text-end font-medium">入库金额</th>
              <th className="w-24 px-3 py-2 text-end font-medium">出库行</th>
              <th className="w-32 px-5 py-2 text-end font-medium">出库金额</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((point) => (
              <tr key={point.month} className="border-b border-separator-border last:border-0">
                <td className="px-5 py-2 font-mono tabular-nums text-text-secondary">{point.month}</td>
                <td className="px-3 py-2 text-end font-mono tabular-nums text-text-tertiary">{count(point.inRows)}</td>
                <td className="px-3 py-2 text-end font-mono tabular-nums text-text-secondary">{money(point.amountInCents)}</td>
                <td className="px-3 py-2 text-end font-mono tabular-nums text-text-tertiary">{count(point.outRows)}</td>
                <td className="px-5 py-2 text-end font-mono tabular-nums text-text-primary">{money(point.amountOutCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
