import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiArrowLeftRightLine,
  RiDeleteBinLine,
  RiFileAddLine,
  RiPencilLine,
  RiPrinterLine,
  RiRefreshLine,
  RiSearchLine,
} from "@remixicon/react";
import { deleteVoucher, fetchFacets, getVoucher, isTauri, listVoucherPage, onFacetsInvalidated } from "../lib/api";
import type { Facets, KindFilter, Voucher, VoucherFilter, VoucherPage, VoucherSummary } from "../lib/types";
import { amount, count, date, money, rowKindLabel, shortTs } from "../lib/format";
import { RANGE_PRESETS, rangeFor } from "../lib/dateRange";
import { useStoredPageSize } from "../lib/pageSize";
import { Button } from "@/components/base/buttons/button";
import { SearchField } from "@/components/base/search-field/search-field";
import { Select, SelectItem } from "@/components/base/select/select";
import { Pagination } from "@/components/base/pagination/pagination";
import { AlertDialog, Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { Spinner } from "@/components/base/spinner/spinner";
import { toast } from "@/components/base/toast/toast";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";
import { ChipGroup } from "../components/ChipGroup";
import { VoucherLinesTable } from "../components/VoucherLinesTable";
import { PrintVoucher } from "../components/PrintVoucher";
import type { VoucherRequest } from "../lib/voucherRequest";

const PAGE_SIZES = [20, 50, 100, 200] as const;
const PAGE_SIZE_KEY = "ledger.records.pageSize";
/** 类型筛选胶囊：`all` 表示不加类型条件；`ret` 只看退回供应商的退货单。 */
const KINDS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "in", label: "入库" },
  { id: "out", label: "出库" },
  { id: "ret", label: "退货" },
];

/**
 * 开单记录页。
 *
 * 开单页底部的「最近开单」只留 5 张做快捷回看，完整历史放这里：
 * 服务端分页 + 条件筛选，底部汇总按整份命中集算（不是当前页）。
 * 详情里能打印、删除，也能把单据交回开单页「载入编辑」或「转单」。
 */
export function VoucherRecordsScreen({
  warehouseName,
  companyName,
  onChanged,
  onNewVoucher,
  onOpenVoucher,
}: {
  warehouseName: string | null;
  /** 本仓打印抬头，A4 打印用 */
  companyName: string | null;
  onChanged: () => void;
  /** 跳回开单页新开一张 */
  onNewVoucher: () => void;
  /** 把单据交给开单页：载入编辑 / 转单 */
  onOpenVoucher: (request: Omit<VoucherRequest, "nonce">) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [kind, setKind] = useState("all");
  const [range, setRange] = useState("all");
  const [owner, setOwner] = useState<string | null>(null);
  const [buyer, setBuyer] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useStoredPageSize(PAGE_SIZE_KEY, PAGE_SIZES, 50);
  const [data, setData] = useState<VoucherPage | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<Voucher | null>(null);
  const [viewingBusy, setViewingBusy] = useState(false);
  const [printing, setPrinting] = useState<Voucher | null>(null);
  // 只留确认文案要用的三个字段：单据可能已不在当前页的 rows 里，
  // 拿 summary 去回查会落空（同开单页的处理）。
  const [pendingDelete, setPendingDelete] = useState<{ id: number; docNo: string; rowCount: number } | null>(null);

  // 关键字防抖：连续敲击时不要每敲一个字就查一次库
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim());
      setPage(1);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const filter = useMemo<VoucherFilter>(() => {
    const { from, to } = rangeFor(range);
    return {
      kind: kind === "all" ? null : (kind as KindFilter),
      keyword: debouncedKeyword || null,
      from,
      to,
      owner,
      buyer,
    };
  }, [kind, debouncedKeyword, range, owner, buyer]);

  // 切筛选/换页时旧请求可能还在飞：用令牌只认最后一次
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!isTauri) return;
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const result = await listVoucherPage(filter, page, pageSize);
      if (ticket !== seq.current) return;
      // 删到最后一页只剩一页时，回到有内容的最后一页，别停在空白页
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setData(result);
    } catch (err) {
      if (ticket === seq.current) toast("开单记录读取失败", { description: String(err), status: "error" });
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [filter, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  // 归属 / 采购人候选：只取当前仓（开单产生的行也算在里面）
  const loadFacets = useCallback(() => {
    fetchFacets(true)
      .then(setFacets)
      .catch(() => {
        // 候选读不到只是少了两个下拉选项，不挡列表
      });
  }, []);

  useEffect(() => {
    loadFacets();
  }, [loadFacets]);

  useEffect(() => onFacetsInvalidated(loadFacets), [loadFacets]);

  const hasFilter = keyword.trim() !== "" || kind !== "all" || range !== "all" || owner !== null || buyer !== null;
  const clearFilters = () => {
    setKeyword("");
    setKind("all");
    setRange("all");
    setOwner(null);
    setBuyer(null);
    setPage(1);
  };

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const openDetail = async (summary: VoucherSummary) => {
    setViewingBusy(true);
    try {
      const voucher = await getVoucher(summary.id);
      if (!voucher) {
        toast("单据不存在", { status: "error" });
        await load();
        return;
      }
      setViewing(voucher);
    } catch (err) {
      toast("单据读取失败", { description: String(err), status: "error" });
    } finally {
      setViewingBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      const removed = await deleteVoucher(pendingDelete.id);
      toast("单据已删除", { description: `${pendingDelete.docNo} · 同时删掉 ${count(removed)} 行明细` });
      setPendingDelete(null);
      setViewing(null);
      await load();
      onChanged();
    } catch (err) {
      toast("删除失败", { description: String(err), status: "error" });
      throw err;
    }
  };

  return (
    <>
      <PageHeader
        title="开单记录"
        description={
          warehouseName
            ? `${warehouseName} · 本机开过的入库单、出库单与退货单，可回看、打印、载入编辑或转单`
            : "本机开过的入库单、出库单与退货单，可回看、打印、载入编辑或转单"
        }
        actions={
          <>
            <Button
              size="small"
              variant="secondary"
              leadingIcon={RiRefreshLine}
              onClick={() => void load()}
              disabled={loading}
            >
              刷新
            </Button>
            <Button size="small" leadingIcon={RiFileAddLine} onClick={onNewVoucher}>
              去开单
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            aria-label="搜索开单记录"
            placeholder="单号 / 送货单号 / 供应商 / 物料 / 采购人"
            size="small"
            shape="rounded"
            value={keyword}
            onChange={setKeyword}
            className="w-72"
          />
          <ChipGroup
            items={KINDS}
            value={kind}
            label="类型"
            onSelect={(next) => {
              setKind(next);
              setPage(1);
            }}
          />
          <Select
            aria-label="日期范围"
            size="sm"
            selectedKey={range}
            onSelectionChange={(key) => {
              setRange(String(key));
              setPage(1);
            }}
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
            selectedKey={owner ?? "all"}
            onSelectionChange={(key) => {
              setOwner(String(key) === "all" ? null : String(key));
              setPage(1);
            }}
            className="w-40"
          >
            <>
              <SelectItem id="all">全部归属</SelectItem>
              {(facets?.owners ?? []).map((name) => (
                <SelectItem key={name} id={name}>
                  {name}
                </SelectItem>
              ))}
            </>
          </Select>
          <Select
            aria-label="采购人"
            size="sm"
            selectedKey={buyer ?? "all"}
            onSelectionChange={(key) => {
              setBuyer(String(key) === "all" ? null : String(key));
              setPage(1);
            }}
            className="w-36"
          >
            <>
              <SelectItem id="all">全部采购人</SelectItem>
              {(facets?.buyers ?? []).map((name) => (
                <SelectItem key={name} id={name}>
                  {name}
                </SelectItem>
              ))}
            </>
          </Select>
          {hasFilter ? (
            <Button size="small" variant="ghost" onClick={clearFilters}>
              清除筛选
            </Button>
          ) : null}
          {loading ? <Spinner size="xs" aria-label="正在加载" /> : null}
          {viewingBusy ? (
            <span className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
              <Spinner size="xs" aria-hidden /> 正在读取单据
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-button-default bg-background-primary-default">
          <table className="w-full min-w-[1160px] table-fixed border-collapse text-[0.8125rem]">
            <thead>
              <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
                <th className="w-[5.5rem] whitespace-nowrap px-3 py-2 text-start font-medium">类型</th>
                <th className="w-[8.5rem] whitespace-nowrap px-3 py-2 text-start font-medium">单据编号</th>
                <th className="w-[8.5rem] whitespace-nowrap px-3 py-2 text-start font-medium">送货单号</th>
                <th className="w-[6.5rem] whitespace-nowrap px-3 py-2 text-start font-medium">日期</th>
                <th className="w-[12rem] px-3 py-2 text-start font-medium">供应商 / 归属</th>
                <th className="min-w-[12rem] px-3 py-2 text-start font-medium">物料</th>
                <th className="w-[5rem] whitespace-nowrap px-3 py-2 text-end font-medium">行数</th>
                <th className="w-[7.5rem] whitespace-nowrap px-3 py-2 text-end font-medium">金额</th>
                <th className="w-[8rem] whitespace-nowrap px-3 py-2 text-start font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-14">
                    <EmptyState
                      icon={RiSearchLine}
                      title={loading ? "正在读取" : hasFilter ? "没有符合条件的单据" : "还没有开过单"}
                      description={
                        hasFilter
                          ? "换个关键字或清掉筛选再试。更早的单也可以用日期范围放宽。"
                          : "去「开单」页录一张入库单或出库单，保存后会出现在这里。"
                      }
                      action={
                        hasFilter ? null : (
                          <Button size="small" variant="secondary" leadingIcon={RiFileAddLine} onClick={onNewVoucher}>
                            去开单
                          </Button>
                        )
                      }
                    />
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => void openDetail(row)}
                    // 行是主要的查看入口：键盘也要能进得去（Enter / Space）
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void openDetail(row);
                      }
                    }}
                    className="cursor-pointer border-b border-separator-border outline-none last:border-0 hover:bg-background-secondary-hover focus-visible:bg-background-secondary-default focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
                  >
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          row.isReturn
                            ? "inline-flex items-center rounded-md bg-amber-500/12 px-1.5 py-0.5 text-caption-1-semibold text-amber-500"
                            : row.kind === "in"
                              ? "inline-flex items-center rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-caption-1-semibold text-emerald-500"
                              : "inline-flex items-center rounded-md bg-sky-500/12 px-1.5 py-0.5 text-caption-1-semibold text-sky-400"
                        }
                      >
                        {rowKindLabel(row)}
                      </span>
                    </td>
                    <td className="truncate px-3 py-1.5 font-mono tabular-nums text-text-primary" title={row.docNo}>
                      {row.docNo}
                    </td>
                    <td
                      className={
                        "truncate px-3 py-1.5 font-mono tabular-nums " +
                        (row.deliveryNo ? "text-text-secondary" : "text-text-tertiary/60")
                      }
                      title={row.deliveryNo ?? ""}
                    >
                      {row.deliveryNo ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-text-secondary">
                      {date(row.docDate)}
                    </td>
                    <td className="truncate px-3 py-1.5 text-text-secondary" title={row.partner ?? row.owner ?? ""}>
                      {row.partner ?? row.owner ?? "—"}
                    </td>
                    <td className="truncate px-3 py-1.5 text-text-tertiary" title={row.firstItem ?? ""}>
                      {row.firstItem ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary">
                      {count(row.rowCount)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-end font-mono tabular-nums text-text-primary">
                      {amount(row.amountCents)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[0.75rem] tabular-nums text-text-tertiary">
                      {shortTs(row.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-body-2-regular text-text-tertiary">
            共 {count(total)} 张 · 入库 {count(data?.inCount ?? 0)} · 出库 {count(data?.outCount ?? 0)}
            {(data?.retCount ?? 0) > 0 ? (
              <span className="text-text-tertiary/70">（其中退货 {count(data?.retCount ?? 0)}）</span>
            ) : null}
            <span className="mx-2 text-text-tertiary/40">·</span>
            合计 <span className="font-mono tabular-nums text-text-secondary">{money(data?.amountCents ?? 0)}</span>
            {total > rows.length ? (
              <span
                className="ms-1 text-caption-1-regular text-text-tertiary/70"
                title="汇总按整份筛选结果算，不只是这一页"
              >
                （全部筛选结果）
              </span>
            ) : null}
          </p>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
              每页
              <select
                aria-label="每页条数"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="h-7 rounded-md border border-border-button-default bg-background-secondary-default px-1.5 font-mono text-caption-1-regular tabular-nums text-text-secondary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              张
            </label>
            <Pagination
              page={page}
              totalPages={totalPages}
              onChange={setPage}
              previousLabel="上一页"
              nextLabel="下一页"
              aria-label="开单记录分页"
            />
          </div>
        </div>
      </div>

      {viewing ? (
        <Modal isOpen onOpenChange={(open: boolean) => !open && setViewing(null)} size="xl">
          {({ close }) => (
            <>
              <ModalHeader
                title={`${rowKindLabel(viewing)}单 ${viewing.docNo}`}
                description={`${date(viewing.docDate)} · ${count(viewing.lines.length)} 行 · ${money(
                  viewing.lines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0),
                )} · ${viewing.partner ?? viewing.owner ?? "—"}${
                  viewing.sourceDocNo ? ` · 原单 ${viewing.sourceDocNo}` : ""
                }`}
              />
              <ModalBody>
                <VoucherLinesTable lines={viewing.lines} showDeliveryNo={viewing.kind === "in"} />
                <p className="mt-2 text-caption-1-regular text-text-tertiary">
                  点「载入编辑」会跳回开单页并把这单读进表单；开单页有未保存内容时会先问你。
                </p>
              </ModalBody>
              <ModalFooter>
                <Button
                  size="small"
                  variant="ghost"
                  leadingIcon={RiDeleteBinLine}
                  onClick={() => {
                    setPendingDelete({ id: viewing.id, docNo: viewing.docNo, rowCount: viewing.lines.length });
                    close();
                  }}
                >
                  删除
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  leadingIcon={RiPrinterLine}
                  onClick={() => {
                    setPrinting(viewing);
                    close();
                  }}
                >
                  A4 打印
                </Button>
                <Button size="small" variant="secondary" onClick={close}>
                  关闭
                </Button>
                {viewing.kind === "in" && !viewing.isReturn ? (
                  <Button
                    size="small"
                    variant="secondary"
                    leadingIcon={RiArrowLeftRightLine}
                    title="按原单未退数量开一张退货单（退回供应商）"
                    onClick={() => {
                      close();
                      onOpenVoucher({ id: viewing.id, action: "return" });
                    }}
                  >
                    退货
                  </Button>
                ) : null}
                {!viewing.isReturn ? (
                  <Button
                    size="small"
                    variant="secondary"
                    leadingIcon={RiArrowLeftRightLine}
                    title={`把这单的明细抄成一张新的${viewing.kind === "in" ? "出库单" : "入库单"}；原单不受影响`}
                    onClick={() => {
                      close();
                      onOpenVoucher({ id: viewing.id, action: "convert" });
                    }}
                  >
                    {viewing.kind === "in" ? "转出库单" : "转入库单"}
                  </Button>
                ) : null}
                <Button
                  size="small"
                  leadingIcon={RiPencilLine}
                  onClick={() => {
                    close();
                    onOpenVoucher({ id: viewing.id, action: "edit" });
                  }}
                >
                  载入编辑
                </Button>
              </ModalFooter>
            </>
          )}
        </Modal>
      ) : null}

      {printing ? (
        <PrintVoucher
          voucher={printing}
          warehouseName={warehouseName}
          companyName={companyName}
          onClose={() => setPrinting(null)}
        />
      ) : null}

      <AlertDialog
        title="删除这张单据"
        description={
          pendingDelete
            ? `将删除 ${pendingDelete.docNo} 及其 ${count(pendingDelete.rowCount)} 行明细。台账里对应的行也会一起消失。`
            : ""
        }
        confirmLabel="删除"
        onConfirm={confirmDelete}
        isOpen={pendingDelete !== null}
        onOpenChange={(open: boolean) => !open && setPendingDelete(null)}
        variant="danger"
      />
    </>
  );
}
