import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAlertLine,
  RiDeleteBinLine,
  RiCheckboxCircleLine,
  RiDownload2Line,
  RiMergeCellsHorizontal,
  RiRefreshLine,
  RiSearchLine,
} from "@remixicon/react";
import {
  bulkDeleteRows,
  bulkUpdateRows,
  deleteRow,
  exportLedger,
  fetchDetail,
  fetchFacets,
  fetchPage,
  isTauri,
} from "../lib/api";
import type { BootstrapInfo, Facets, Kind, LedgerFilter, LedgerPage, LedgerRow } from "../lib/types";
import { amount, count, date, flagLabel, kindLabel, money, priceText, qty } from "../lib/format";
import { useVirtualRows } from "../lib/useVirtualRows";
import { mergeRowsByDoc, onMergeByDocChange, saveMergeByDoc, storedMergeByDoc } from "../lib/mergeDocs";
import { Button } from "@/components/base/buttons/button";
import { Pagination } from "@/components/base/pagination/pagination";
import { Input } from "@/components/base/input/input";
import { SearchField } from "@/components/base/search-field/search-field";
import { Select, SelectItem } from "@/components/base/select/select";
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from "@/components/base/table/table";
import { AlertDialog, Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";
import { Spinner } from "@/components/base/spinner/spinner";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";
import { RowDetail } from "../components/RowDetail";

const PAGE_SIZE = 100;
const ROW_HEIGHT = 36;
const KINDS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "in", label: "入库" },
  { id: "out", label: "出库" },
];
const RANGE_PRESETS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "month", label: "本月" },
  { id: "lastMonth", label: "上月" },
  { id: "thisYear", label: "本年" },
];
function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rangeFor(preset: string): { from: string | null; to: string | null } {
  const now = new Date();
  if (preset === "month") {
    return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
  }
  if (preset === "lastMonth") {
    return {
      from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  if (preset === "thisYear") {
    return { from: `${now.getFullYear()}-01-01`, to: isoDate(now) };
  }
  return { from: null, to: null };
}

interface LedgerScreenProps {
  boot: BootstrapInfo | null;
  onChanged: () => void;
}

export function LedgerScreen({ boot, onChanged }: LedgerScreenProps) {
  const [filter, setFilter] = useState<LedgerFilter>({ sort: "date", desc: true });
  const [keyword, setKeyword] = useState("");
  const [kind, setKind] = useState("all");
  const [range, setRange] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LedgerPage | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<LedgerRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LedgerRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkConfirmDelete, setBulkConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  // 按单据合并：同一张单据的明细折成一行显示；关闭就是逐行明细
  const [mergeByDoc, setMergeByDoc] = useState(() => storedMergeByDoc());
  const requestId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 关键字防抖后再查
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setFilter((prev) => ({ ...prev, keyword: keyword.trim() || null }));
    }, 260);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    fetchFacets()
      .then(setFacets)
      .catch((err: unknown) => toast("筛选项读取失败", { description: String(err), status: "error" }));
  }, []);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    try {
      const result = await fetchPage(filter, page, PAGE_SIZE);
      if (current === requestId.current) {
        setData(result);
        // 换页/换筛选后旧的选择已经没有意义
        setSelectedIds(new Set());
      }
    } catch (err) {
      toast("台账加载失败", { description: String(err), status: "error", duration: 6000 });
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 窗口切片只在逐行模式用；合并状态下直接整页渲染
  const virtual = useVirtualRows(scrollRef, mergeByDoc ? 0 : rows.length, ROW_HEIGHT);

  /**
   * 按单据合并时，把同一单的相邻明细折成一行；关闭时就是原样的逐行明细。
   * 合并必须对整页 rows 做（窗口切片会切断相邻行），切片放在合并之后。
   */
  const displayRows = useMemo(() => {
    const merged = mergeRowsByDoc(rows, mergeByDoc);
    return rows.length > 60 && !mergeByDoc ? merged.slice(virtual.start, virtual.end) : merged;
  }, [rows, mergeByDoc, virtual.start, virtual.end]);

  useEffect(() => onMergeByDocChange(setMergeByDoc), []);

  const toggleMerge = () => {
    const next = !mergeByDoc;
    saveMergeByDoc(next);
    setMergeByDoc(next);
    setSelectedIds(new Set());
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const applyKind = (value: string) => {
    setKind(value);
    setPage(1);
    setFilter((prev) => ({ ...prev, kind: value === "all" ? null : (value as Kind) }));
  };

  const applyRange = (value: string) => {
    setRange(value);
    setPage(1);
    const { from, to } = rangeFor(value);
    setFilter((prev) => ({ ...prev, from, to }));
  };

  const chooseWarehouse = (key: string) => {
    setPage(1);
    setFilter((prev) => ({ ...prev, buyer: key === "all" ? null : key }));
  };

  const chooseOwner = (key: string) => {
    setPage(1);
    setFilter((prev) => ({ ...prev, owner: key === "all" ? null : key }));
  };

  const toggleSort = (column: "date" | "amount" | "qty") => {
    setPage(1);
    setFilter((prev) =>
      prev.sort === column ? { ...prev, desc: !prev.desc } : { ...prev, sort: column, desc: true },
    );
  };

  const openDetail = async (row: LedgerRow) => {
    setDetailId(row.id);
    setDetail(row);
    try {
      const fresh = await fetchDetail(row.id);
      if (fresh) setDetail(fresh);
    } catch {
      // 详情读失败就先用列表里的那份
    }
  };

  const doExport = async () => {
    if (!isTauri) {
      window.location.href = `/api/ledger/export.csv?${new URLSearchParams(
        Object.entries(filter).reduce<Record<string, string>>((acc, [key, value]) => {
          if (value !== null && value !== undefined && value !== "") acc[key] = String(value);
          return acc;
        }, {}),
      )}`;
      return;
    }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const path = await save({
        title: "导出台账",
        defaultPath: `仓库出入库明细_${stamp}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      setBusy(true);
      const result = await exportLedger(filter, path);
      toast("已导出", { description: `${result.rows.toLocaleString()} 行 → ${result.path}`, status: "success" });
    } catch (err) {
      toast("导出失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

const runBulkUpdate = async (patch: { owner?: string; buyer?: string; remark?: string }) => {
    if (selectedIds.size === 0) return;
    setBusy(true);
    try {
      const changed = await bulkUpdateRows(Array.from(selectedIds), patch);
      toast(`已修改 ${count(changed)} 行`, { status: "success" });
      setBulkOpen(false);
      setSelectedIds(new Set());
      await load();
      onChanged();
    } catch (err) {
      toast("批量修改失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const runBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBusy(true);
    try {
      const removed = await bulkDeleteRows(Array.from(selectedIds));
      toast(`已删除 ${count(removed)} 行`, { description: "开单产生的单据如果明细被删空，单据头也会一起清掉" });
      setBulkConfirmDelete(false);
      setSelectedIds(new Set());
      await load();
      onChanged();
    } catch (err) {
      toast("批量删除失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await deleteRow(pendingDelete.id);
      toast("已删除一行", { description: `${pendingDelete.itemName ?? pendingDelete.itemCode ?? ""} · 源表第 ${pendingDelete.rowNo} 行` });
      setPendingDelete(null);
      setDetailId(null);
      await load();
      onChanged();
    } catch (err) {
      toast("删除失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const totals = data?.totals;
  const activeFilterCount =
    (filter.kind ? 1 : 0) + (filter.owner ? 1 : 0) + (filter.buyer ? 1 : 0) + (filter.from ? 1 : 0) + (filter.keyword ? 1 : 0);

  return (
    <>
      <PageHeader
        title="台账"
        description={boot ? `共 ${count(boot.rowCount)} 行 · 入库 ${count(boot.inRows)} · 出库 ${count(boot.outRows)}` : "入库与出库明细"}
        actions={
          <>
            <Button size="small" variant="secondary" leadingIcon={RiRefreshLine} onClick={load} disabled={loading}>
              刷新
            </Button>
            <Button size="small" variant="secondary" leadingIcon={RiDownload2Line} onClick={doExport} disabled={busy || total === 0}>
              导出 CSV
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        {/* 筛选条：一行放下，窄屏换行 */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            aria-label="搜索单据、物料、供应商"
            placeholder="单号 / 物料 / 供应商 / 备注"
            size="small"
            shape="rounded"
            value={keyword}
            onChange={setKeyword}
            className="w-72"
          />
          <ChipGroup items={KINDS} value={kind} onSelect={applyKind} label="类型" />
          <Select
            aria-label="日期范围"
            size="sm"
            selectedKey={range}
            onSelectionChange={(key) => applyRange(String(key))}
            className="w-32"
          >
            {RANGE_PRESETS.map((preset) => (
              <SelectItem key={preset.id} id={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </Select>
          <Select
            aria-label="归属"
            size="sm"
            selectedKey={filter.owner ?? "all"}
            onSelectionChange={(key) => chooseOwner(String(key))}
            className="w-40"
          >
            <>
              <SelectItem id="all">全部归属</SelectItem>
              {(facets?.owners ?? []).map((owner) => (
                <SelectItem key={owner} id={owner}>
                  {owner}
                </SelectItem>
              ))}
            </>
          </Select>
          <Select
            aria-label="采购人"
            size="sm"
            selectedKey={filter.buyer ?? "all"}
            onSelectionChange={(key) => chooseWarehouse(String(key))}
            className="w-36"
          >
            <>
              <SelectItem id="all">全部采购人</SelectItem>
              {(facets?.buyers ?? []).map((buyer) => (
                <SelectItem key={buyer} id={buyer}>
                  {buyer}
                </SelectItem>
              ))}
            </>
          </Select>
          {activeFilterCount > 0 ? (
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                setKeyword("");
                setKind("all");
                setRange("all");
                setFilter({ sort: "date", desc: true });
                setPage(1);
              }}
            >
              清除筛选
            </Button>
          ) : null}
          <Button
            size="small"
            variant={mergeByDoc ? "primary" : "secondary"}
            leadingIcon={RiMergeCellsHorizontal}
            aria-pressed={mergeByDoc}
            title="同一张单据的多行合成一行显示（只合并当前页；空单号的行不合并）"
            onClick={toggleMerge}
          >
            按单据合并
          </Button>
          {loading ? <Spinner size="xs" aria-label="正在加载" /> : null}
        </div>

        {/* 批量操作栏：只在有选择时出现，避免常态占位置 */}
        {selectedIds.size > 0 && isTauri ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2">
            <span className="text-body-2-medium text-text-primary">
              已选 {count(selectedIds.size)} 行
            </span>
            <span className="text-caption-1-regular text-text-tertiary">批量只改归属/采购人/备注，数量金额需逐行核对</span>
            <div className="ms-auto flex items-center gap-2">
              <Button size="small" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                取消选择
              </Button>
              <Button size="small" variant="secondary" onClick={() => setBulkOpen(true)} disabled={busy}>
                批量改…
              </Button>
              <Button
                size="small"
                variant="secondary"
                leadingIcon={RiDeleteBinLine}
                onClick={() => setBulkConfirmDelete(true)}
                disabled={busy}
                className="text-text-destructive"
              >
                批量删除
              </Button>
            </div>
          </div>
        ) : null}

        {/* 合计条：跟着筛选走，跟表格的数字对得上 */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-separator-border bg-separator-border md:grid-cols-4">
          <Stat label="筛选结果" value={count(total)} unit="行" sub={`入库 ${count(totals?.inRows ?? 0)} · 出库 ${count(totals?.outRows ?? 0)}`} />
          <Stat label="入库金额" value={money(totals?.amountInCents ?? 0)} sub={`入库数量 ${qty(totals?.qtyIn ?? 0)}`} />
          <Stat label="出库金额" value={money(totals?.amountOutCents ?? 0)} sub={`出库数量 ${qty(totals?.qtyOut ?? 0)}`} />
          <Stat label="涉及单据" value={count(totals?.docCount ?? 0)} unit="张" sub={`物料 ${count(totals?.itemCount ?? 0)} 种`} />
        </div>

        <div className="scroll-fade-wrap min-h-0 flex-1">
          <div ref={scrollRef} className="ledger-table h-full overflow-auto rounded-xl border border-separator-border bg-background-primary-default">
            <Table
              aria-label="出入库明细"
              className="min-w-[1220px] table-fixed text-[13px]"
              containerClassName="min-w-0"
            >
              <TableHeader>
                <TableColumn id="select" className="w-[40px]" aria-label="选择">
                  <input
                    type="checkbox"
                    aria-label="全选本页"
                    checked={rows.length > 0 && selectedIds.size === rows.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < rows.length;
                    }}
                    onChange={(e) => {
                      setSelectedIds(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set());
                    }}
                    className="size-3.5 cursor-pointer accent-accent-500"
                  />
                </TableColumn>
                <TableColumn id="kind" className="w-[64px]">类型</TableColumn>
                <TableColumn id="date" className="w-[104px]">
                  <SortHeader label="日期" active={filter.sort === 'date'} desc={Boolean(filter.desc)} onClick={() => toggleSort('date')} />
                </TableColumn>
                <TableColumn id="doc" className="w-[128px]">单据编号</TableColumn>
                <TableColumn id="code" className="w-[132px]">物料编码</TableColumn>
                <TableColumn id="name" isRowHeader className="w-[260px]">物料名称</TableColumn>
                <TableColumn id="unit" className="w-[56px]">单位</TableColumn>
                <TableColumn id="qty" className="w-[84px] text-end">
                  <SortHeader label="数量" active={filter.sort === 'qty'} desc={Boolean(filter.desc)} onClick={() => toggleSort('qty')} />
                </TableColumn>
                <TableColumn id="price" className="w-[88px] text-end">单价</TableColumn>
                <TableColumn id="amount" className="w-[104px] text-end">
                  <SortHeader label="合计" active={filter.sort === 'amount'} desc={Boolean(filter.desc)} onClick={() => toggleSort('amount')} />
                </TableColumn>
                <TableColumn id="partner" className="w-[120px]">供应商</TableColumn>
                <TableColumn id="owner" className="w-[120px]">归属</TableColumn>
                <TableColumn id="flags" className="w-[92px]">提醒</TableColumn>
              </TableHeader>
              <TableBody
                renderEmptyState={() => (
                  <div className="px-4 py-16">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2 text-body-2-regular text-text-tertiary">
                        <Spinner size="xs" aria-label="加载中" /> 正在读取
                      </div>
                    ) : (
                      <EmptyState
                        icon={RiSearchLine}
                        title={total === 0 && !activeFilterCount ? "台账还是空的" : "当前条件下没有记录"}
                        description={
                          total === 0 && !activeFilterCount
                            ? "去「导入」页选一个 Excel 工作簿，认出入库明细后落库。"
                            : "换个日期范围或清掉关键字再试。"
                        }
                      />
                    )}
                  </div>
                )}
              >
                {!mergeByDoc && rows.length > 60 && virtual.padTop > 0 ? (
                  <TableRow aria-hidden className="border-0">
                    <TableCell colSpan={13} style={{ height: virtual.padTop, padding: 0 }} />
                  </TableRow>
                ) : null}
                {displayRows.map((row) => (
                  <TableRow
                    key={row.id}
                    id={String(row.id)}
                    className="h-9 cursor-default transition-colors hover:bg-background-secondary-hover data-[selected=true]:bg-background-secondary-default"
                    onAction={() => openDetail(row)}
                    onDoubleClick={() => openDetail(row)}
                  >
                    <TableCell className="w-[40px]">
                      <input
                        type="checkbox"
                        aria-label={`选择第 ${row.rowNo} 行`}
                        // 合并行代表多条明细，按整单批量改/删的语义还没定，先禁用
                        disabled={mergeByDoc && row.groupCount > 1}
                        title={mergeByDoc && row.groupCount > 1 ? "合并行不支持勾选，关掉合并后逐行操作" : undefined}
                        checked={selectedIds.has(row.id)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(row.id);
                            else next.delete(row.id);
                            return next;
                          });
                        }}
                        className="size-3.5 cursor-pointer accent-accent-500"
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          row.kind === "in"
                            ? "inline-flex items-center rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-caption-1-semibold text-emerald-500"
                            : "inline-flex items-center rounded-md bg-sky-500/12 px-1.5 py-0.5 text-caption-1-semibold text-sky-400"
                        }
                      >
                        {kindLabel(row.kind)}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-text-secondary">{date(row.docDate)}</TableCell>
                    <TableCell className="font-mono tabular-nums text-text-secondary">{row.docNo ?? "—"}</TableCell>
                    <TableCell className="font-mono text-text-tertiary">{row.itemCode ?? "—"}</TableCell>
                    <TableCell className="truncate text-text-primary">
                      <span title={row.allItemNames.join("、")}>{row.itemName ?? "—"}</span>
                      {row.groupCount > 1 ? (
                        <span className="ms-1.5 rounded bg-background-secondary-default px-1.5 py-0.5 text-caption-1-regular text-text-tertiary">
                          {count(row.groupCount)} 行
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-text-tertiary">{row.unit ?? "—"}</TableCell>
                    <TableCell className="num text-text-secondary">{qty(row.qty)}</TableCell>
                    <TableCell className="num text-text-tertiary">{row.priceMicros === null ? "—" : priceText(row.priceMicros)}</TableCell>
                    <TableCell className="num text-text-primary">{amount(row.amountCents)}</TableCell>
                    <TableCell className="truncate text-text-secondary">
                      <span title={row.partner ?? ""}>{row.partner ?? "—"}</span>
                    </TableCell>
                    <TableCell className="truncate text-text-secondary">
                      <span title={row.owner ?? ""}>{row.owner ?? "—"}</span>
                    </TableCell>
                    <TableCell>
                      {row.flags.length === 0 ? (
                        <RiCheckboxCircleLine className="size-4 text-text-tertiary/40" aria-label="无提醒" />
                      ) : (
                        <span className="inline-flex items-center gap-1 text-caption-1-semibold text-amber-500">
                          <RiAlertLine className="size-3.5" aria-hidden />
                          {flagLabel(row.flags[0])}
                          {row.flags.length > 1 ? ` +${row.flags.length - 1}` : ""}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {!mergeByDoc && rows.length > 60 && virtual.padBottom > 0 ? (
                  <TableRow aria-hidden className="border-0">
                    <TableCell colSpan={13} style={{ height: virtual.padBottom, padding: 0 }} />
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div aria-hidden className="scroll-fade" />
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-body-2-regular text-text-tertiary">
            {mergeByDoc ? (
              <>
                本页 {count(displayRows.length)} 条（合并自 {count(rows.length)} 行），共 {count(total)} 行
                <span className="mx-2 text-text-tertiary/40">·</span>
                只合并当前页，空单号的行不合并
              </>
            ) : (
              <>
                第 {count((page - 1) * PAGE_SIZE + 1)}–{count(Math.min(page * PAGE_SIZE, total))} 行，共 {count(total)} 行
                <span className="mx-2 text-text-tertiary/40">·</span>
                单击一行看完整字段
              </>
            )}
          </p>
          <Pagination
            page={page}
            totalPages={totalPages}
            onChange={(next) => {
              setPage(next);
              scrollRef.current?.scrollTo({ top: 0 });
            }}
            previousLabel="上一页"
            nextLabel="下一页"
            aria-label="台账分页"
          />
        </div>
      </div>

      {detailId !== null && detail ? (
        <RowDetail
          row={detail}
          canEdit={isTauri}
          onClose={() => {
            setDetailId(null);
            setDetail(null);
          }}
          onSaved={async () => {
            await load();
            onChanged();
            if (detail) {
              const fresh = await fetchDetail(detail.id);
              setDetail(fresh);
            }
          }}
          onDelete={(row) => setPendingDelete(row)}
        />
      ) : null}

      <AlertDialog
        title="删除这一行"
        description={
          pendingDelete
            ? `将删除「${pendingDelete.itemName ?? ""}」源表第 ${pendingDelete.rowNo} 行。删除只影响本机台账，不改原 Excel。`
            : ""
        }
        confirmLabel="删除"
        onConfirm={confirmDelete}
        isOpen={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        variant="danger"
      />

      <BulkEditDialog
        isOpen={bulkOpen}
        count={selectedIds.size}
        busy={busy}
        onClose={() => setBulkOpen(false)}
        onApply={runBulkUpdate}
      />

      <AlertDialog
        title="批量删除"
        description={`将删除选中的 ${count(selectedIds.size)} 行。这一步不能撤销；开单产生的单据若明细被清空，单据头也会一起删掉。`}
        confirmLabel="删除"
        onConfirm={runBulkDelete}
        isOpen={bulkConfirmDelete}
        onOpenChange={(open: boolean) => !open && setBulkConfirmDelete(false)}
        variant="danger"
      />
    </>
  );
}


/** 列头排序按钮：点一下切换方向，用一个小箭头表示当前方向。 */
function SortHeader({
  label,
  active,
  desc,
  onClick,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={
        "inline-flex items-center gap-1 rounded-sm text-start outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring " +
        (active ? "text-text-primary" : "text-text-tertiary")
      }
      aria-sort={active ? (desc ? "descending" : "ascending") : "none"}
    >
      {label}
      <span aria-hidden className={active ? "text-text-secondary" : "text-text-tertiary/30"}>
        {active && !desc ? "↑" : "↓"}
      </span>
    </button>
  );
}

function ChipGroup({
  items,
  value,
  onSelect,
  label,
}: {
  items: { id: string; label: string }[];
  value: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-lg bg-background-secondary-default p-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={value === item.id}
          onClick={() => onSelect(item.id)}
          className={
            "h-7 rounded-md px-2.5 text-caption-1-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring " +
            (value === item.id
              ? "bg-background-primary-default text-text-primary shadow-xs ring-1 ring-separator-border"
              : "text-text-tertiary hover:text-text-secondary")
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="bg-background-primary-default px-4 py-3">
      <p className="text-caption-1-semibold text-text-tertiary">{label}</p>
      <p className="mt-1 flex items-baseline gap-1">
        <span className="font-mono text-title-3-semibold tabular-nums text-text-primary">{value}</span>
        {unit ? <span className="text-body-2-regular text-text-tertiary">{unit}</span> : null}
      </p>
      {sub ? <p className="mt-0.5 text-caption-1-regular text-text-tertiary">{sub}</p> : null}
    </div>
  );
}

/** 批量改：三个字段留空表示不改，只把填了的应用下去。 */
function BulkEditDialog({
  isOpen,
  count: rowCount,
  busy,
  onClose,
  onApply,
}: {
  isOpen: boolean;
  count: number;
  busy: boolean;
  onClose: () => void;
  onApply: (patch: { owner?: string; buyer?: string; remark?: string }) => Promise<void>;
}) {
  const [owner, setOwner] = useState("");
  const [buyer, setBuyer] = useState("");
  const [remark, setRemark] = useState("");

  const submit = async () => {
    const patch: { owner?: string; buyer?: string; remark?: string } = {};
    if (owner.trim()) patch.owner = owner.trim();
    if (buyer.trim()) patch.buyer = buyer.trim();
    if (remark.trim()) patch.remark = remark.trim();
    if (Object.keys(patch).length === 0) {
      toast("没有填要改的内容", { description: "留空的字段不会改动。", status: "error" });
      return;
    }
    await onApply(patch);
    setOwner("");
    setBuyer("");
    setRemark("");
  };

  if (!isOpen) return null;
  return (
    <Modal isOpen onOpenChange={(open: boolean) => !open && onClose()} size="sm">
      {({ close }) => (
        <>
          <ModalHeader
            title={`批量修改 ${rowCount} 行`}
            description="只填要改的字段；留空的保持原样"
          />
          <ModalBody className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-caption-1-semibold text-text-tertiary">归属</span>
              <Input size="small" placeholder="留空不改" value={owner} onChange={setOwner} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption-1-semibold text-text-tertiary">采购人</span>
              <Input size="small" placeholder="留空不改" value={buyer} onChange={setBuyer} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption-1-semibold text-text-tertiary">备注</span>
              <Input size="small" placeholder="留空不改" value={remark} onChange={setRemark} />
            </label>
          </ModalBody>
          <ModalFooter>
            <Button size="small" variant="secondary" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button size="small" onClick={submit} disabled={busy}>
              {busy ? "应用中" : "应用"}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}
