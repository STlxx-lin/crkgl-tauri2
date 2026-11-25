import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAlertLine,
  RiCheckboxCircleLine,
  RiDownload2Line,
  RiRefreshLine,
  RiSearchLine,
} from "@remixicon/react";
import { countStock, fetchStockCheck, fetchStockReport, isTauri, updateRow } from "../lib/api";
import type { StockCheckSummary, StockIssue, StockRow } from "../lib/types";
import { count, date, qty } from "../lib/format";
import { exportFileName } from "../lib/exportCsv";
import { useStoredPageSize } from "../lib/pageSize";
import { Button } from "@/components/base/buttons/button";
import { ItemPicker } from "../components/ItemPicker";
import { SearchField } from "@/components/base/search-field/search-field";
import { Spinner } from "@/components/base/spinner/spinner";
import { Pagination } from "@/components/base/pagination/pagination";
import { toast } from "@/components/base/toast/toast";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";

const PAGE_SIZES = [50, 100, 200, 500] as const;
const PAGE_SIZE_KEY = "stock.pageSize";

type Tab = "stock" | "issues";

/**
 * 库存页。两件事：
 *
 * · 结存：按物料看「入库 - 出库」，能搜、能只看负库存、能导 CSV。
 * · 核对：把要人处理的数据挑出来——负库存物料、缺物料编码的行、数量异常的行。
 *
 * 这一页只读，不改任何数据：修正动作（补入库单、改台账行）由用户在各自页面完成。
 */
export function StockScreen({ onChanged }: { onChanged?: () => void }) {
  const [tab, setTab] = useState<Tab>("stock");

  return (
    <>
      <PageHeader
        title="库存"
        description="结存 = 入库数量 - 出库数量；核对清单只提示问题，不自动改数据"
        actions={
          <Button size="small" variant="secondary" leadingIcon={RiRefreshLine} onClick={onChanged}>
            刷新
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div role="tablist" aria-label="库存视图" className="mb-4 flex items-center gap-1">
          {(
            [
              ["stock", "库存结存"],
              ["issues", "数据核对"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={
                "h-8 rounded-lg px-3 text-body-2-medium transition-colors " +
                (tab === id
                  ? "bg-background-secondary-default text-text-primary ring-1 ring-separator-border"
                  : "text-text-tertiary hover:text-text-secondary")
              }
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "stock" ? <StockTable /> : <IssueList />}
      </div>
    </>
  );
}

function StockTable() {
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [onlyNegative, setOnlyNegative] = useState(false);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pageSize, setPageSize] = useStoredPageSize(PAGE_SIZE_KEY, PAGE_SIZES, 100);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageIndex = Math.min(pageCount, Math.floor(offset / pageSize) + 1);
  const tableRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // 关键字防抖后再查，避免连续敲击时向数据库排队发送重复重查询
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOffset(0);
      setDebouncedKeyword(keyword.trim());
    }, 260);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    setOffset(0);
  }, [onlyNegative, pageSize]);

  const load = useCallback(async () => {
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const opts = {
        keyword: debouncedKeyword || undefined,
        onlyNegative,
        limit: pageSize,
        offset,
      };
      const [list, n] = await Promise.all([fetchStockReport(opts), countStock(opts.keyword, onlyNegative)]);
      if (ticket === seq.current) {
        setRows(list);
        setTotal(n);
      }
    } catch (err) {
      toast("库存读取失败", { description: String(err), status: "error" });
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [debouncedKeyword, onlyNegative, offset, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    let inQty = 0;
    let outQty = 0;
    for (const row of rows) {
      inQty += row.inQty;
      outQty += row.outQty;
    }
    return { inQty, outQty, stock: inQty - outQty };
  }, [rows]);

  const [exporting, setExporting] = useState(false);

  /**
   * 导出 CSV。
   *
   * `all=false` 只导当前页（按钮原本就是这个语义）；`all=true` 按当前筛选
   * 分页把结果全部取回再拼——库存对账通常需要全量，只给当前页容易被误当全量。
   * 文件名统一走 `exportFileName`，取本地日期而不是 UTC（跨零点导出时才对得上）。
   */
  const exportCsv = async (all: boolean) => {
    let data = rows;
    if (all) {
      setExporting(true);
      try {
        const collected: StockRow[] = [];
        const pageSize = 2000;
        for (let offset = 0; ; offset += pageSize) {
          const batch = await fetchStockReport({
            keyword: debouncedKeyword || undefined,
            onlyNegative,
            limit: pageSize,
            offset,
          });
          collected.push(...batch);
          if (batch.length < pageSize) break;
        }
        data = collected;
      } catch (err) {
        toast("导出失败", { description: String(err), status: "error" });
        return;
      } finally {
        setExporting(false);
      }
    }
    // 这条报表是给人对账用的，能丢进 Excel 比什么都实在
    const header = ["物料编码", "物料名称", "库位", "规格型号", "单位", "入库数量", "出库数量", "结存", "最近日期"];
    const lines = data.map((row) =>
      [row.itemCode, row.itemName, row.location ?? "", row.spec ?? "", row.unit ?? "", row.inQty, row.outQty, row.stockQty, row.lastDate ?? ""]
        .map(csvCell)
        .join(","),
    );
    const csv = "\uFEFF" + [header.join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName("库存结存");
    a.click();
    URL.revokeObjectURL(url);
    toast(all ? "已导出全部筛选结果" : "已导出当前页", {
      description: `${count(data.length)} 行`,
      status: "success",
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          aria-label="搜索物料"
          placeholder="物料编码 / 名称 / 库位 / 规格"
          size="small"
          shape="rounded"
          value={keyword}
          onChange={setKeyword}
          className="w-72"
        />
        <button
          type="button"
          aria-pressed={onlyNegative}
          onClick={() => setOnlyNegative((v) => !v)}
          className={
            "h-8 rounded-lg px-3 text-body-2-medium transition-colors " +
            (onlyNegative
              ? "bg-amber-500/15 text-amber-500 ring-1 ring-amber-500/40"
              : "text-text-tertiary hover:text-text-secondary")
          }
        >
          只看负库存
        </button>
        {loading ? <Spinner size="xs" aria-label="加载中" /> : null}
        <span className="text-body-2-regular text-text-tertiary">
          共 {count(total)} 个物料
        </span>
        <div className="ms-auto flex items-center gap-2">
          <Button
            size="small"
            variant="secondary"
            leadingIcon={RiDownload2Line}
            onClick={() => void exportCsv(false)}
            disabled={rows.length === 0 || exporting}
          >
            导出本页 CSV
          </Button>
          <Button
            size="small"
            variant="secondary"
            leadingIcon={RiDownload2Line}
            onClick={() => void exportCsv(true)}
            disabled={total === 0 || exporting}
            title="按当前筛选（关键字 / 只看负库存）导出全部物料，不只是这一页"
          >
            {exporting ? "导出中…" : "导出全部"}
          </Button>
          <Button size="small" variant="ghost" leadingIcon={RiRefreshLine} onClick={load} disabled={loading}>
            刷新
          </Button>
        </div>
      </div>

      <div ref={tableRef} className="overflow-x-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[1170px] table-fixed border-collapse text-[0.8125rem]">
          <thead>
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="w-[160px] whitespace-nowrap px-3 py-2 text-start font-medium">物料编码</th>
              <th className="min-w-[200px] px-3 py-2 text-start font-medium">物料名称</th>
              <th className="w-[120px] whitespace-nowrap px-3 py-2 text-start font-medium">库位</th>
              <th className="w-[150px] whitespace-nowrap px-3 py-2 text-start font-medium">规格型号</th>
              <th className="w-[80px] whitespace-nowrap px-3 py-2 text-start font-medium">单位</th>
              <th className="w-[110px] whitespace-nowrap px-3 py-2 text-end font-medium">入库</th>
              <th className="w-[110px] whitespace-nowrap px-3 py-2 text-end font-medium">出库</th>
              <th className="w-[120px] whitespace-nowrap px-3 py-2 text-end font-medium">结存</th>
              <th className="w-[120px] whitespace-nowrap px-3 py-2 text-start font-medium">最近日期</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-14">
                  <EmptyState
                    icon={RiSearchLine}
                    title={loading ? "正在读取" : onlyNegative ? "没有负库存物料" : "没有匹配的物料"}
                    description={onlyNegative ? "结存都为正，可以放心出库。" : "换个编码或名称再试。"}
                  />
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.itemCode} className="border-b border-separator-border last:border-0 hover:bg-background-secondary-hover">
                  <td className="truncate whitespace-nowrap px-3 py-1.5 font-mono text-[0.75rem] text-text-secondary" title={row.itemCode}>
                    {row.itemCode}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-primary" title={row.itemName}>
                    {row.itemName}
                  </td>
                  <td className="truncate whitespace-nowrap px-3 py-1.5 font-mono text-[0.75rem] text-text-tertiary" title={row.location ?? ""}>
                    {row.location ?? "—"}
                  </td>
                  <td className="truncate whitespace-nowrap px-3 py-1.5 font-mono text-[0.75rem] text-text-tertiary" title={row.spec ?? ""}>
                    {row.spec ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-text-tertiary">{row.unit ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary">{qty(row.inQty)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary">{qty(row.outQty)}</td>
                  <td
                    className={
                      "whitespace-nowrap px-3 py-1.5 text-end font-mono tabular-nums font-medium " +
                      (row.stockQty < 0 ? "text-amber-500" : "text-text-primary")
                    }
                  >
                    {qty(row.stockQty)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[0.75rem] tabular-nums text-text-tertiary">
                    {row.lastDate ? date(row.lastDate) : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
        <p className="text-body-2-regular text-text-tertiary">
          第 {count(offset + 1)}–{count(Math.min(offset + pageSize, total))} 个，共 {count(total)} 个
          <span className="mx-2 text-text-tertiary/40">·</span>
          本页入库 {qty(totals.inQty)} / 出库 {qty(totals.outQty)} / 结存 {qty(totals.stock)}
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
            每页
            <select
              aria-label="每页条数"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setOffset(0);
                tableRef.current?.scrollTo({ top: 0 });
              }}
              className="h-7 rounded-md border border-border-button-default bg-background-secondary-default px-1.5 font-mono text-caption-1-regular tabular-nums text-text-secondary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            条
          </label>
          <Pagination
            page={pageIndex}
            totalPages={pageCount}
            onChange={(next) => {
              setOffset(Math.max(0, (next - 1) * pageSize));
              tableRef.current?.scrollTo({ top: 0 });
            }}
            previousLabel="上一页"
            nextLabel="下一页"
            aria-label="库存分页"
          />
        </div>
      </div>
    </div>
  );
}

const ISSUE_LABEL: Record<string, string> = {
  negative_stock: "负库存",
  missing_code: "缺物料编码",
  bad_qty: "数量异常",
};

function IssueList() {
  const [issues, setIssues] = useState<StockIssue[]>([]);
  const [summary, setSummary] = useState<StockCheckSummary | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  // 正在补填物料编码的那一行（只有缺编码的行能补）
  const [filling, setFilling] = useState<StockIssue | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { issues: list, summary: s } = await fetchStockCheck();
      setIssues(list);
      setSummary(s);
    } catch (err) {
      toast("核对清单读取失败", { description: String(err), status: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(
    () => (filter === "all" ? issues : issues.filter((i) => i.kind === filter)),
    [issues, filter],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-separator-border bg-separator-border md:grid-cols-3">
        <IssueStat
          label="负库存物料"
          value={count(summary?.negativeItems ?? 0)}
          unit="个"
          sub={summary && summary.negativeItems > 0 ? `合计缺口 ${qty(summary.negativeGap)}` : "没有负库存"}
          tone={summary && summary.negativeItems > 0 ? "warn" : "ok"}
        />
        <IssueStat
          label="缺物料编码"
          value={count(summary?.missingCodeRows ?? 0)}
          unit="行"
          sub="不计入结存，也开不了单"
          tone={summary && summary.missingCodeRows > 0 ? "warn" : "ok"}
        />
        <IssueStat
          label="数量异常"
          value={count(summary?.badQtyRows ?? 0)}
          unit="行"
          sub="数量为空、0 或负数"
          tone={summary && summary.badQtyRows > 0 ? "warn" : "ok"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", "全部"],
            ["negative_stock", "负库存"],
            ["missing_code", "缺编码"],
            ["bad_qty", "数量异常"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
            className={
              "h-8 rounded-lg px-3 text-body-2-medium transition-colors " +
              (filter === id
                ? "bg-background-secondary-default text-text-primary ring-1 ring-separator-border"
                : "text-text-tertiary hover:text-text-secondary")
            }
          >
            {label}
          </button>
        ))}
        {loading ? <Spinner size="xs" aria-label="加载中" /> : null}
        <span className="ms-auto text-caption-1-regular text-text-tertiary">
          修正办法：负库存在开单页补一张入库单；其余到台账里改对应行
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[1180px] table-fixed border-collapse text-[0.8125rem]">
          <thead>
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="w-[140px] whitespace-nowrap px-3 py-2 text-start font-medium">类型</th>
              <th className="w-[160px] whitespace-nowrap px-3 py-2 text-start font-medium">物料编码</th>
              <th className="w-[240px] px-3 py-2 text-start font-medium">物料名称</th>
              <th className="w-[110px] whitespace-nowrap px-3 py-2 text-end font-medium">数量</th>
              <th className="w-[140px] whitespace-nowrap px-3 py-2 text-start font-medium">单据</th>
              <th className="w-[120px] whitespace-nowrap px-3 py-2 text-start font-medium">日期</th>
              <th className="min-w-[270px] px-3 py-2 text-start font-medium">说明</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-14">
                  <EmptyState
                    icon={RiCheckboxCircleLine}
                    title={loading ? "正在读取" : "没有发现问题"}
                    description="负库存、缺编码、数量异常都为空。"
                  />
                </td>
              </tr>
            ) : (
              shown.map((issue, index) => (
                <tr
                  key={`${issue.kind}-${issue.ledgerId ?? issue.itemCode}-${index}`}
                  onClick={() => {
                    // 只有「缺物料编码」能直接补；负库存要靠补入库单，数量异常去台账改
                    if (issue.kind === "missing_code" && isTauri) setFilling(issue);
                  }}
                  className={
                    "border-b border-separator-border last:border-0 hover:bg-background-secondary-hover " +
                    (issue.kind === "missing_code" && isTauri ? "cursor-pointer" : "")
                  }
                  title={issue.kind === "missing_code" && isTauri ? "点这一行补填物料编码" : issue.detail}
                >
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <span
                      className={
                        "inline-block whitespace-nowrap rounded px-2 py-0.5 text-caption-1-semibold " +
                        (issue.kind === "negative_stock"
                          ? "bg-amber-500/12 text-amber-500"
                          : "bg-sky-500/12 text-sky-400")
                      }
                    >
                      {ISSUE_LABEL[issue.kind] ?? issue.kind}
                    </span>
                  </td>
                  <td className="truncate whitespace-nowrap px-3 py-1.5 font-mono text-[0.75rem] text-text-secondary">
                    {issue.itemCode ?? "—"}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-primary" title={issue.itemName ?? ""}>
                    {issue.itemName ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary">
                    {issue.qty === null ? "—" : qty(issue.qty)}
                  </td>
                  <td className="truncate whitespace-nowrap px-3 py-1.5 font-mono text-[0.75rem] text-text-tertiary">
                    {issue.docNo ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[0.75rem] tabular-nums text-text-tertiary">
                    {issue.docDate ? date(issue.docDate) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-caption-1-regular text-text-tertiary" title={issue.detail}>
                    <span className="flex items-center gap-2">
                      <span className="truncate">{issue.detail}</span>
                      {issue.kind === "missing_code" && isTauri ? (
                        <span className="shrink-0 rounded bg-accent-500/12 px-1.5 py-0.5 text-caption-1-semibold text-accent-500">
                          点击补填
                        </span>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-caption-1-regular text-text-tertiary">
        共 {count(shown.length)} 条{filter === "all" ? "" : "（已筛选）"}；每类最多列 300 条。
        {isTauri ? " 「缺编码」的行可以直接点击补填。" : ""}
      </p>

      {filling ? (
        <FillCodeDialog
          issue={filling}
          onClose={() => setFilling(null)}
          onSaved={async () => {
            setFilling(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function IssueStat({
  label,
  value,
  unit,
  sub,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  sub: string;
  tone: "ok" | "warn";
}) {
  return (
    <div className="bg-background-primary-default px-5 py-4">
      <p className="text-caption-1-semibold text-text-tertiary">{label}</p>
      <p className="mt-1 flex items-baseline gap-1">
        <span className={"font-mono text-title-3-semibold tabular-nums " + (tone === "warn" ? "text-amber-500" : "text-text-primary")}>
          {value}
        </span>
        <span className="text-caption-1-regular text-text-tertiary">{unit}</span>
        {tone === "warn" ? <RiAlertLine className="size-3.5 text-amber-500" aria-hidden /> : null}
      </p>
      <p className="mt-0.5 text-caption-1-regular text-text-tertiary">{sub}</p>
    </div>
  );
}

/** CSV 单元格转义：含逗号/引号/换行就加引号并翻倍引号。 */
function csvCell(value: string | number): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * 给缺物料编码的台账行补编码。
 *
 * 只改这一行的 `item_code`（必要时连名称/单位一起对齐选中物料），
 * 不动数量金额——这些是原始凭证上的数，改了就说不清了。
 */
function FillCodeDialog({
  issue,
  onClose,
  onSaved,
}: {
  issue: StockIssue;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [code, setCode] = useState(issue.itemCode ?? "");
  const [name, setName] = useState(issue.itemName ?? "");
  const [unit, setUnit] = useState(issue.unit ?? "");
  const [saving, setSaving] = useState(false);

  const canSave = code.trim() !== "" && issue.ledgerId !== null;

  const save = async () => {
    if (!canSave || issue.ledgerId === null) return;
    setSaving(true);
    try {
      await updateRow(issue.ledgerId, {
        itemCode: code.trim(),
        itemName: name.trim() || null,
        unit: unit.trim() || null,
      });
      toast("物料编码已补上", {
        description: `${code.trim()} · ${name.trim() || "（无名称）"}`,
        status: "success",
      });
      await onSaved();
    } catch (err) {
      toast("保存失败", { description: String(err), status: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onOpenChange={(open: boolean) => !open && onClose()} size="lg">
      {({ close }) => (
        <>
          <ModalHeader
            title="补物料编码"
            description={
              `台账第 ${issue.ledgerId} 行 · ${issue.kindLabel ?? "—"} · ${issue.qty ?? "—"} ${issue.unit ?? ""}` +
              (issue.docNo ? ` · 单据 ${issue.docNo}` : "")
            }
          />
          <ModalBody className="flex flex-col gap-3">
            <div className="rounded-xl border border-separator-border bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-tertiary">
              {issue.detail}。补上编码后这一行才会进结存，也能在开单时被选中。
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-caption-1-semibold text-text-tertiary">物料编码</span>
              <ItemPicker
                value={code}
                source="master"
                inStockOnly={false}
                placeholder="选已有物料，或直接输入新编码"
                onPick={(item) => {
                  setCode(item.itemCode);
                  setName(item.itemName);
                  setUnit(item.unit ?? "");
                }}
                onChangeText={setCode}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
              <label className="flex flex-col gap-1">
                <span className="text-caption-1-semibold text-text-tertiary">物料名称</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="物料名称"
                  className="h-9 w-full rounded-lg border border-border-button-default bg-background-secondary-default px-2.5 text-body-regular text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-caption-1-semibold text-text-tertiary">单位</span>
                <input
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="单位"
                  className="h-9 w-full rounded-lg border border-border-button-default bg-background-secondary-default px-2.5 text-body-regular text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
                />
              </label>
            </div>

            <p className="text-caption-1-regular text-text-tertiary">
              只改编码、名称、单位；数量和金额保持原样。
            </p>
          </ModalBody>
          <ModalFooter>
            <Button size="small" variant="secondary" onClick={close} disabled={saving}>
              取消
            </Button>
            <Button size="small" onClick={save} disabled={!canSave || saving}>
              {saving ? "保存中" : "保存编码"}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}
