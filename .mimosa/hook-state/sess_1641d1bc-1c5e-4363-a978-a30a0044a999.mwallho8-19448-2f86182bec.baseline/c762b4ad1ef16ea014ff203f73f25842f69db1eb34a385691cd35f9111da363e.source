import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiFileAddLine,
  RiFileList3Line,
  RiPrinterLine,
  RiSearchLine,
  RiSaveLine,
} from "@remixicon/react";
import {
  createVoucher,
  deleteVoucher,
  listSuppliers,
  getVoucher,
  isTauri,
  fetchDocLines,
  listVouchers,
  nextDocNo,
  searchDocs,
  updateVoucher,
} from "../lib/api";
import type { DocHit, Item, Kind, LedgerRow, Supplier, Voucher, VoucherLineInput, VoucherSummary } from "../lib/types";
import { amount, count, date, flagLabel, kindLabel, money, priceText, qty } from "../lib/format";
import { Button } from "@/components/base/buttons/button";
import { AlertDialog, Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";
import { Spinner } from "@/components/base/spinner/spinner";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";
import { ItemPicker } from "../components/ItemPicker";
import { ComboPicker } from "../components/ComboPicker";
import { PrintVoucher } from "../components/PrintVoucher";
import { saveBuyer, storedBuyer, onBuyerChange } from "../lib/voucherPrefs";

type Mode = { kind: Kind; id: number | null };

interface DraftLine {
  key: string;
  /** 送货单号（入库逐行填，出库为空） */
  deliveryNo: string;
  itemCode: string;
  itemName: string;
  unit: string;
  qty: string;
  price: string;
  remark: string;
}

interface HeadDraft {
  docNo: string;
  docDate: string;
  partner: string;
  buyer: string;
  owner: string;
  receiver: string;
  /** 仓管签字（纸单底部有，只做记录） */
  storekeeper: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

let lineSeq = 0;
function blankLine(): DraftLine {
  lineSeq += 1;
  return { key: `l${lineSeq}`, deliveryNo: "", itemCode: "", itemName: "", unit: "", qty: "", price: "", remark: "" };
}

function blankHead(kind: Kind): HeadDraft {
  return {
    docNo: "",
    docDate: today(),
    partner: "",
    buyer: kind === "in" ? storedBuyer() : "",
    owner: "",
    receiver: "",
    storekeeper: "",
  };
}

/**
 * 开单页：入库单 / 出库单。
 *
 * 表单结构照 Excel 里那两张单子：表头（供应商/送货单号/单据编号、归属/出库时间/单据编号）
 * 加明细行（物料编码、名称、单位、数量、单价、合计、备注）。
 * 选物料时从历史台账带出单位与最近单价，减少重复录入。
 */
export function VoucherScreen({ onChanged }: { onChanged: () => void }) {
  const [mode, setMode] = useState<Mode>({ kind: "in", id: null });
  const [head, setHead] = useState<HeadDraft>(() => blankHead("in"));
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine()]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [history, setHistory] = useState<VoucherSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<VoucherSummary | null>(null);
  // A4 打印：用当前录入内容出稿，未保存也能先打一份校样
  const [printing, setPrinting] = useState(false);
  // 单据查询：跨「本机开单」与「Excel 导入」两种来源
  const [docQuery, setDocQuery] = useState("");
  const [docHits, setDocHits] = useState<DocHit[] | null>(null);
  const [docSearching, setDocSearching] = useState(false);
  const [viewingImport, setViewingImport] = useState<{ hit: DocHit; lines: LedgerRow[] } | null>(null);
  const dirty = useRef(false);

  const loadHistory = useCallback(async () => {
    if (!isTauri) return;
    try {
      setHistory(await listVouchers(null, 50));
    } catch (err) {
      toast("单据列表读取失败", { description: String(err), status: "error" });
    }
  }, []);

  const loadSuppliers = useCallback(async () => {
    if (!isTauri) return;
    try {
      const list = await listSuppliers();
      setSuppliers(list.filter((s) => s.active));
    } catch {
      // 供应商只是便利功能，读不到不影响手填
    }
  }, []);

  const freshDocNo = useCallback(async (kind: Kind, docDate: string) => {
    try {
      const no = await nextDocNo(kind, docDate || today());
      setHead((prev) => ({ ...prev, docNo: no }));
    } catch (err) {
      toast("取号失败", { description: String(err), status: "error" });
    }
  }, []);

  useEffect(() => {
    loadSuppliers();
    loadHistory();
  }, [loadSuppliers, loadHistory]);

  // 保存过新采购人后，正在编辑的空白新单跟着换默认值（已填的不动）
  useEffect(() => onBuyerChange((buyer) => {
    setHead((prev) => (prev.buyer.trim() === "" ? { ...prev, buyer } : prev));
  }), []);

  useEffect(() => {
    if (mode.id === null) {
      freshDocNo(mode.kind, head.docDate);
    }
    // 只在新建单据且日期变化时取号
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind, mode.id]);

  const totals = useMemo(() => {
    let amount = 0;
    let qtySum = 0;
    let pieces = 0;
    for (const line of lines) {
      const q = Number(line.qty);
      const p = Number(line.price);
      if (Number.isFinite(q) && Number.isFinite(p)) amount += Math.round(q * p * 100);
      if (Number.isFinite(q)) qtySum += q;
      if (line.itemCode || line.itemName) pieces += 1;
    }
    return { amount, pieces, qty: qtySum };
  }, [lines]);

  const setLine = (key: string, patch: Partial<DraftLine>) => {
    dirty.current = true;
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  /** 把当前录入内容拼成打印视图要的 Voucher 形状（不落库）。 */
  const printDraft = useMemo<Voucher>(() => {
    const draftLines = lines.map((line, index) => {
      const q = line.qty.trim() === "" ? null : Number(line.qty);
      const p = line.price.trim() === "" ? null : Math.round(Number(line.price) * 10_000);
      return {
        id: index + 1,
        ledgerId: index + 1,
        deliveryNo: line.deliveryNo.trim() || null,
        itemCode: line.itemCode.trim() || null,
        itemName: line.itemName.trim() || null,
        unit: line.unit.trim() || null,
        qty: q === null || !Number.isFinite(q) ? null : q,
        priceMicros: p === null || !Number.isFinite(p) ? null : p,
        amountCents: q === null || p === null ? null : Math.round((q * p) / 100),
        remark: line.remark.trim() || null,
      };
    });
    return {
      id: mode.id ?? 0,
      kind: mode.kind,
      docNo: head.docNo,
      docDate: head.docDate,
      partner: mode.kind === "in" ? head.partner.trim() || null : head.owner.trim() || null,
      deliveryNo: null,
      buyer: head.buyer.trim() || null,
      owner: head.owner.trim() || null,
      receiver: head.receiver.trim() || null,
      remark: null,
      rowCount: draftLines.length,
      amountCents: draftLines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0),
      createdAt: "",
      sheet: `voucher:${mode.kind}`,
      lines: draftLines,
    };
  }, [lines, head, mode]);

  /** 选中物料编码：顺带带出名称、单位、最近单价。 */
  /** 从物料选择器选中一条：带出名称、单位、参考单价（出库不带单价）。 */
  const applyMaster = (key: string, item: Item) => {
    const patch: Partial<DraftLine> = {
      itemCode: item.itemCode,
      itemName: item.itemName,
      unit: item.unit ?? "",
    };
    if (mode.kind === "in" && item.priceMicros !== null && item.priceMicros !== undefined) {
      patch.price = String(item.priceMicros / 10_000);
    }
    setLine(key, patch);
  };

  const startNew = async (kind: Kind) => {
    setMode({ kind, id: null });
    setHead(blankHead(kind));
    setLines([blankLine()]);
    dirty.current = false;
    await freshDocNo(kind, today());
  };

  const openVoucher = async (summary: VoucherSummary) => {
    setBusy(true);
    try {
      const voucher = await getVoucher(summary.id);
      if (!voucher) {
        toast("单据不存在", { status: "error" });
        return;
      }
      setMode({ kind: voucher.kind, id: voucher.id });
      setHead({
        docNo: voucher.docNo,
        docDate: voucher.docDate,
        partner: voucher.partner ?? "",
        buyer: voucher.buyer ?? "",
        owner: voucher.owner ?? "",
        receiver: voucher.receiver ?? "",
        storekeeper: "",
      });
      setLines(
        voucher.lines.length > 0
          ? voucher.lines.map((line) => {
              lineSeq += 1;
              return {
                key: `l${lineSeq}`,
                // 旧单据的送货单号存在单头，回填到每行
                deliveryNo: line.deliveryNo ?? voucher.deliveryNo ?? "",
                itemCode: line.itemCode ?? "",
                itemName: line.itemName ?? "",
                unit: line.unit ?? "",
                qty: line.qty === null ? "" : String(line.qty),
                price: line.priceMicros === null ? "" : (line.priceMicros / 10000).toFixed(4),
                remark: line.remark ?? "",
              };
            })
          : [blankLine()],
      );
      dirty.current = false;
    } catch (err) {
      toast("单据读取失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!isTauri) {
      toast("只读站不能开单", { description: "请在装有本程序的电脑上开单。", status: "error" });
      return;
    }
    const payloadLines: VoucherLineInput[] = lines
      .filter((line) => line.itemCode.trim() || line.itemName.trim() || line.qty.trim())
      .map((line) => {
        const p = Number(line.price);
        return {
          itemCode: line.itemCode.trim() || null,
          deliveryNo: line.deliveryNo.trim() || null,
          itemName: line.itemName.trim() || null,
          unit: line.unit.trim() || null,
          qty: line.qty.trim() === "" ? null : Number(line.qty),
          priceMicros: mode.kind === "in" && Number.isFinite(p) && line.price.trim() !== "" ? Math.round(p * 10000) : null,
          remark: line.remark.trim() || null,
        };
      });

    const payload = {
      kind: mode.kind,
      docNo: head.docNo.trim() || null,
      docDate: head.docDate,
      partner: head.partner.trim() || null,
      buyer: mode.kind === "in" ? head.buyer.trim() || null : null,
      owner: mode.kind === "out" ? head.owner.trim() || null : null,
      receiver: mode.kind === "out" ? head.receiver.trim() || null : null,
      // 单头备注已去掉入口；备注按行填。这里固定 null，旧单据的备注仍在库里不回写。
      remark: null,
      lines: payloadLines,
    };

    setBusy(true);
    try {
      if (mode.id === null) {
        const id = await createVoucher(payload);
        toast("单据已保存", { description: `${head.docNo} · ${count(payloadLines.length)} 行`, status: "success" });
        setMode({ kind: mode.kind, id });
      } else {
        await updateVoucher(mode.id, payload);
        toast("单据已更新", { description: `${head.docNo} · ${count(payloadLines.length)} 行`, status: "success" });
      }
      dirty.current = false;
      // 下次新开单沿用这次填的采购人
      if (mode.kind === "in" && head.buyer.trim()) saveBuyer(head.buyer);
      await loadHistory();
      onChanged();
    } catch (err) {
      toast("保存失败", { description: String(err), status: "error", duration: 7000 });
    } finally {
      setBusy(false);
    }
  };

const runDocSearch = useCallback(async (keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) {
      setDocHits(null);
      return;
    }
    setDocSearching(true);
    try {
      setDocHits(await searchDocs(trimmed, null, 50));
    } catch (err) {
      toast("查询失败", { description: String(err), status: "error" });
      setDocHits([]);
    } finally {
      setDocSearching(false);
    }
  }, []);

  /** 点查询结果：本机单直接载入编辑器，导入单弹只读明细。 */
  const openHit = async (hit: DocHit) => {
    if (hit.voucherId !== null) {
      await openVoucher({
        id: hit.voucherId,
        kind: hit.kind,
        docNo: hit.docNo,
        docDate: hit.docDate ?? "",
        partner: hit.partner,
        owner: hit.owner,
        rowCount: hit.rowCount,
        amountCents: hit.amountCents,
        createdAt: "",
      });
      return;
    }
    setBusy(true);
    try {
      const lines = await fetchDocLines(hit.docNo, hit.kind);
      setViewingImport({ hit, lines });
    } catch (err) {
      toast("明细读取失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      const removed = await deleteVoucher(pendingDelete.id);
      toast("单据已删除", { description: `${pendingDelete.docNo} · 同时删掉 ${count(removed)} 行明细` });
      setPendingDelete(null);
      if (mode.id === pendingDelete.id) await startNew(mode.kind);
      await loadHistory();
      onChanged();
    } catch (err) {
      toast("删除失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const isIn = mode.kind === "in";

  return (
    <>
      <PageHeader
        title="开单"
        description="本机新开的入库单与出库单会和 Excel 导入的明细一起出现在台账里"
        actions={
          <>
            <Button
              size="small"
              variant={isIn ? "primary" : "secondary"}
              leadingIcon={RiFileAddLine}
              onClick={() => startNew("in")}
              disabled={busy}
            >
              新入库单
            </Button>
            <Button
              size="small"
              variant={isIn ? "secondary" : "primary"}
              leadingIcon={RiFileAddLine}
              onClick={() => startNew("out")}
              disabled={busy}
            >
              新出库单
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          {/* 单据主体：按纸单布局排 —— 居中标题、表头横带、明细、合计行、签字行 */}
          <section className="flex flex-col rounded-2xl border border-border-button-default bg-background-primary-default">
            {/* 单头：公司名 + 单据名（居中，和纸单一致） */}
            <div className="border-b border-separator-border px-6 py-4 text-center">
              <p className="text-caption-1-regular text-text-tertiary">温州乾力机械有限公司</p>
              <h2 className="mt-1 text-title-2-semibold tracking-wide text-text-primary">
                {isIn ? "入库单" : "出库单"}
              </h2>
              {mode.id !== null ? (
                <p className="mt-0.5 font-mono text-caption-1-regular tabular-nums text-text-tertiary">
                  编辑 #${mode.id}
                </p>
              ) : null}
            </div>

            {/* 第 3 行横带：供应商名称 → 输入 → 日期 → 单据编号（出库单换成归属） */}
            <div className="grid grid-cols-1 gap-3 border-b border-separator-border px-5 py-3 md:grid-cols-[auto_1fr_auto_auto]">

              {isIn ? (
                <span className="self-center text-body-2-medium text-text-secondary">供应商名称：</span>
              ) : (
                <span className="self-center text-body-2-medium text-text-secondary">归属：</span>
              )}
              <ComboPicker
                ariaLabel={isIn ? "供应商" : "归属"}
                value={isIn ? head.partner : head.owner}
                onChange={(v) =>
                  setHead((prev) => (isIn ? { ...prev, partner: v } : { ...prev, owner: v }))
                }
                options={
                  isIn
                    ? suppliers.map((sup) => ({ value: sup.name, hint: sup.hits > 0 ? `${sup.hits} 行` : undefined }))
                    : []
                }
                allowCustom
                placeholder={isIn ? "选或输入供应商" : "选或输入归属"}
              />
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">{isIn ? "入库时间：" : "出库时间："}</span>
                <input
                  aria-label={isIn ? "入库时间" : "出库时间"}
                  value={head.docDate}
                  onChange={(e) => setHead((prev) => ({ ...prev, docDate: e.target.value }))}
                  onBlur={() => {
                    if (mode.id === null) freshDocNo(mode.kind, head.docDate);
                  }}
                  className="h-9 w-36 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 font-mono text-[13px] tabular-nums text-text-primary outline-none focus:border-border-focus-ring"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">单据编号：</span>
                <input
                  aria-label="单据编号"
                  value={head.docNo}
                  onChange={(e) => setHead((prev) => ({ ...prev, docNo: e.target.value }))}
                  className="h-9 w-36 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 font-mono text-[13px] tabular-nums text-text-primary outline-none focus:border-border-focus-ring"
                />
              </div>
            </div>

            {/* 明细表：列与纸单一致；送货单号逐行填（一张单可能对应多张送货单） */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
                    <th className="w-10 px-2 py-2 text-center font-medium">#</th>
                    {isIn ? <th className="w-36 px-2 py-2 text-start font-medium">送货单号</th> : null}
                    <th className="w-36 px-2 py-2 text-start font-medium">物料编码</th>
                    <th className="px-2 py-2 text-start font-medium">物料名称</th>
                    <th className="w-16 px-2 py-2 text-start font-medium">单位</th>
                    <th className="w-24 px-2 py-2 text-end font-medium">数量</th>
                    {isIn ? <th className="w-28 px-2 py-2 text-end font-medium">单价</th> : null}
                    {isIn ? <th className="w-28 px-2 py-2 text-end font-medium">合计</th> : null}
                    <th className="w-40 px-2 py-2 text-start font-medium">备注</th>
                    <th className="w-10 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => {
                    const amount =
                      Number.isFinite(Number(line.qty)) && Number.isFinite(Number(line.price)) && line.price !== ""
                        ? Number(line.qty) * Number(line.price)
                        : null;
                    return (
                      <tr key={line.key} className="border-b border-separator-border last:border-0">
                        <td className="px-2 py-1 text-center font-mono text-[11px] tabular-nums text-text-tertiary">
                          {index + 1}
                        </td>
                        {isIn ? (
                          <td className="px-1 py-1">
                            <input
                              aria-label={`第 ${index + 1} 行送货单号`}
                              value={line.deliveryNo}
                              onChange={(e) => setLine(line.key, { deliveryNo: e.target.value })}
                              placeholder="送货单号"
                              className="h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 font-mono text-[12px] tabular-nums text-text-secondary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                            />
                          </td>
                        ) : null}
                        <td className="px-1 py-1">
                          <ItemPicker
                            value={line.itemCode}
                            onPick={(item) => applyMaster(line.key, item)}
                            onChangeText={(text) => setLine(line.key, { itemCode: text })}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            value={line.itemName}
                            onChange={(e) => setLine(line.key, { itemName: e.target.value })}
                            placeholder="物料名称"
                            className="h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 text-text-primary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            value={line.unit}
                            onChange={(e) => setLine(line.key, { unit: e.target.value })}
                            placeholder="单位"
                            className="h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 text-text-secondary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            inputMode="decimal"
                            value={line.qty}
                            onChange={(e) => setLine(line.key, { qty: e.target.value })}
                            placeholder="0"
                            className="h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 text-end font-mono tabular-nums text-text-primary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                          />
                        </td>
                        {isIn ? (
                          <td className="px-1 py-1">
                            <input
                              inputMode="decimal"
                              value={line.price}
                              onChange={(e) => setLine(line.key, { price: e.target.value })}
                              placeholder="0.00"
                              className="h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 text-end font-mono tabular-nums text-text-secondary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                            />
                          </td>
                        ) : null}
                        {isIn ? (
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-primary">
                            {amount === null ? "—" : money(Math.round(amount * 100))}
                          </td>
                        ) : null}
                        <td className="px-1 py-1">
                          <input
                            value={line.remark}
                            onChange={(e) => setLine(line.key, { remark: e.target.value })}
                            placeholder="备注"
                            className="h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 text-text-tertiary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                          />
                        </td>
                        <td className="px-1 py-1 text-center">
                          <button
                            type="button"
                            aria-label={`删除第 ${index + 1} 行`}
                            onClick={() => {
                              dirty.current = true;
                              setLines((prev) => (prev.length === 1 ? [blankLine()] : prev.filter((l) => l.key !== line.key)));
                            }}
                            className="inline-flex size-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-destructive"
                          >
                            <RiDeleteBinLine className="size-4" aria-hidden />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {/* 合计行：与纸单一致，单独一行 */}
                  <tr className="border-t border-separator-border bg-background-secondary-default">
                    <td colSpan={isIn ? 4 : 3} className="px-2 py-2 text-end text-caption-1-semibold text-text-secondary">
                      合计
                      <span className="ms-2 font-normal text-caption-1-regular text-text-tertiary">
                        {count(totals.pieces)} 行有物料
                      </span>
                    </td>
                    <td />
                    <td className="px-2 py-2 text-end font-mono text-body-2-medium tabular-nums text-text-secondary">
                      {qty(totals.qty)}
                    </td>
                    {isIn ? <td /> : null}
                    {isIn ? (
                      <td className="px-2 py-2 text-end font-mono text-body-2-medium tabular-nums text-text-primary">
                        {money(totals.amount)}
                      </td>
                    ) : null}
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 签字行：采购人 / 仓管 / 领用人，照纸单放在最底 */}
            <div className="grid grid-cols-1 gap-3 border-t border-separator-border px-5 py-3 md:grid-cols-3">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">采购人：</span>
                <input
                  aria-label="采购人"
                  value={head.buyer}
                  onChange={(e) => setHead((prev) => ({ ...prev, buyer: e.target.value }))}
                  className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-body-regular text-text-primary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">仓管：</span>
                <input
                  aria-label="仓管"
                  value={head.storekeeper}
                  onChange={(e) => setHead((prev) => ({ ...prev, storekeeper: e.target.value }))}
                  placeholder="签字"
                  className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-body-regular text-text-primary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">领用人：</span>
                <input
                  aria-label="领用人签字"
                  value={head.receiver}
                  onChange={(e) => setHead((prev) => ({ ...prev, receiver: e.target.value }))}
                  placeholder="签字"
                  className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-body-regular text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                />
              </div>
            </div>

            {/* 操作条 */}
            <div className="flex flex-wrap items-center gap-2 border-t border-separator-border px-5 py-3">
              <Button
                size="small"
                variant="secondary"
                leadingIcon={RiAddLine}
                onClick={() => {
                  dirty.current = true;
                  setLines((prev) => [...prev, blankLine()]);
                }}
              >
                加一行
              </Button>
              <span className="text-caption-1-regular text-text-tertiary">
                选物料编码会自动带出名称、单位与最近单价
              </span>
              <div className="ms-auto flex items-center gap-2">
                {busy ? <Spinner size="xs" aria-label="保存中" /> : null}
                <Button size="small" variant="secondary" leadingIcon={RiPrinterLine} onClick={() => setPrinting(true)}>
                  A4 打印
                </Button>
                <Button size="small" leadingIcon={RiSaveLine} onClick={submit} disabled={busy || !isTauri}>
                  {mode.id === null ? "保存单据" : "保存修改"}
                </Button>
                {mode.id !== null ? (
                  <Button
                    size="small"
                    variant="secondary"
                    leadingIcon={RiDeleteBinLine}
                    onClick={() => {
                      const hit = history.find((v) => v.id === mode.id);
                      if (hit) setPendingDelete(hit);
                    }}
                  >
                    删除单据
                  </Button>
                ) : null}
              </div>
            </div>
            {!isTauri ? (
              <p className="border-t border-separator-border px-5 py-2 text-caption-1-regular text-text-tertiary">
                只读站不能开单，请在桌面端操作。
              </p>
            ) : null}
          </section>

          {/* 单据查询：按编号查，跨本机开单与导入两种来源 */}
          <section className="flex flex-col gap-2 rounded-2xl border border-border-button-default bg-background-primary-default p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-title-4-semibold text-text-primary">单据查询</h2>
              <span className="text-caption-1-regular text-text-tertiary">编号可只填片段</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={docQuery}
                onChange={(e) => setDocQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runDocSearch(docQuery);
                }}
                placeholder="单据编号，如 20260831206 或 0831"
                className="h-8 min-w-0 flex-1 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 font-mono text-[12px] tabular-nums text-text-primary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
              />
              <Button size="small" leadingIcon={RiSearchLine} onClick={() => runDocSearch(docQuery)} disabled={docSearching || !isTauri}>
                查询
              </Button>
            </div>
            {docSearching ? (
              <div className="flex items-center gap-2 py-2 text-caption-1-regular text-text-tertiary">
                <Spinner size="xs" aria-label="查询中" /> 正在查
              </div>
            ) : docHits === null ? null : docHits.length === 0 ? (
              <p className="py-2 text-caption-1-regular text-text-tertiary">
                没找到编号包含「{docQuery.trim()}」的单据
              </p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-0.5 overflow-auto">
                {docHits.map((hit) => (
                  <li key={hit.source + hit.docNo + hit.kind}>
                    <button
                      type="button"
                      onClick={() => openHit(hit)}
                      className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-background-secondary-hover"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={
                            hit.kind === "in"
                              ? "rounded bg-emerald-500/12 px-1 py-0.5 text-[11px] font-medium text-emerald-500"
                              : "rounded bg-sky-500/12 px-1 py-0.5 text-[11px] font-medium text-sky-400"
                          }
                        >
                          {kindLabel(hit.kind)}
                        </span>
                        <span className="font-mono text-body-2-medium tabular-nums text-text-primary">{hit.docNo}</span>
                        {hit.source === "import" ? (
                          <span className="rounded bg-background-secondary-default px-1 py-0.5 text-[10px] text-text-tertiary">
                            导入
                          </span>
                        ) : null}
                        <span className="ms-auto text-caption-1-regular text-text-tertiary">{date(hit.docDate)}</span>
                      </span>
                      <span className="flex items-center gap-2 text-caption-1-regular text-text-tertiary">
                        <span className="truncate">{hit.partner ?? hit.owner ?? "—"}</span>
                        <span className="ms-auto shrink-0 font-mono tabular-nums">
                          {count(hit.rowCount)} 行 · {money(hit.amountCents)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 单据列表 */}
          <section className="flex flex-col rounded-2xl border border-border-button-default bg-background-primary-default">
            <div className="flex items-baseline justify-between gap-2 px-4 pb-2 pt-4">
              <h2 className="text-title-4-semibold text-text-primary">本机开单</h2>
              <span className="text-caption-1-regular text-text-tertiary">{count(history.length)} 张</span>
            </div>
            {history.length === 0 ? (
              <div className="px-4 pb-8 pt-2">
                <EmptyState
                  icon={RiFileList3Line}
                  title="还没有开过单"
                  description="左边填一张入库单或出库单，保存后会出现在台账里。"
                />
              </div>
            ) : (
              <ul className="max-h-[560px] overflow-auto px-2 pb-3">
                {history.map((voucher) => (
                  <li key={voucher.id}>
                    <button
                      type="button"
                      onClick={() => openVoucher(voucher)}
                      className={
                        "flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-start transition-colors hover:bg-background-secondary-hover " +
                        (mode.id === voucher.id ? "bg-background-secondary-default" : "")
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={
                            voucher.kind === "in"
                              ? "rounded bg-emerald-500/12 px-1 py-0.5 text-[11px] font-medium text-emerald-500"
                              : "rounded bg-sky-500/12 px-1 py-0.5 text-[11px] font-medium text-sky-400"
                          }
                        >
                          {kindLabel(voucher.kind)}
                        </span>
                        <span className="font-mono text-body-2-medium tabular-nums text-text-primary">{voucher.docNo}</span>
                        <span className="ms-auto text-caption-1-regular text-text-tertiary">{date(voucher.docDate)}</span>
                      </span>
                      <span className="flex items-center gap-2 text-caption-1-regular text-text-tertiary">
                        <span className="truncate">{voucher.partner ?? voucher.owner ?? "—"}</span>
                        <span className="ms-auto shrink-0 font-mono tabular-nums">
                          {count(voucher.rowCount)} 行 · {money(voucher.amountCents)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

{viewingImport ? (
        <Modal isOpen onOpenChange={(open: boolean) => !open && setViewingImport(null)} size="xl">
          {({ close }) => (
            <>
              <ModalHeader
                title={`${kindLabel(viewingImport.hit.kind)}单 ${viewingImport.hit.docNo}`}
                description={`${date(viewingImport.hit.docDate)} · ${count(viewingImport.lines.length)} 行 · ${
                  viewingImport.hit.partner ?? viewingImport.hit.owner ?? "—"
                } · 来自 Excel 导入，只读`}
              />
              <ModalBody>
                <div className="overflow-x-auto rounded-xl border border-separator-border">
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="border-b border-separator-border bg-background-tertiary-default text-caption-1-semibold text-text-tertiary">
                        <th className="w-12 px-2 py-2 text-center font-medium">源行</th>
                        <th className="w-32 px-2 py-2 text-start font-medium">物料编码</th>
                        <th className="px-2 py-2 text-start font-medium">物料名称</th>
                        <th className="w-14 px-2 py-2 text-start font-medium">单位</th>
                        <th className="w-24 px-2 py-2 text-end font-medium">数量</th>
                        <th className="w-24 px-2 py-2 text-end font-medium">单价</th>
                        <th className="w-28 px-2 py-2 text-end font-medium">合计</th>
                        <th className="w-24 px-2 py-2 text-start font-medium">提醒</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingImport.lines.map((line) => (
                        <tr key={line.id} className="border-b border-separator-border last:border-0">
                          <td className="px-2 py-1 text-center font-mono text-[11px] tabular-nums text-text-tertiary">
                            {line.rowNo}
                          </td>
                          <td className="truncate px-2 py-1 font-mono text-[12px] text-text-secondary">
                            {line.itemCode ?? "—"}
                          </td>
                          <td className="truncate px-2 py-1 text-text-primary" title={line.itemName ?? ""}>
                            {line.itemName ?? "—"}
                          </td>
                          <td className="px-2 py-1 text-text-tertiary">{line.unit ?? "—"}</td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-secondary">{qty(line.qty)}</td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-tertiary">
                            {line.priceMicros === null ? "—" : priceText(line.priceMicros)}
                          </td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-primary">
                            {line.amountCents === null ? "—" : amount(line.amountCents)}
                          </td>
                          <td className="px-2 py-1 text-[11px] leading-4 text-amber-500">
                            {line.flags.length > 0 ? line.flags.map(flagLabel).join(" ") : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button size="small" variant="secondary" onClick={close}>
                  关闭
                </Button>
              </ModalFooter>
            </>
          )}
        </Modal>
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

      {printing ? <PrintVoucher voucher={printDraft} onClose={() => setPrinting(false)} /> : null}
    </>
  );
}

