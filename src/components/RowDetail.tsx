import { useState } from "react";
import { RiAlertLine, RiDeleteBinLine } from "@remixicon/react";
import type { LedgerRow } from "../lib/types";
import { flagLabel, rowKindLabel, shortTs } from "../lib/format";
import { updateRow } from "../lib/api";
import { Button } from "@/components/base/buttons/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { Input } from "@/components/base/input/input";
import { toast } from "@/components/base/toast/toast";

interface RowDetailProps {
  row: LedgerRow;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDelete: (row: LedgerRow) => void;
}

/**
 * 台账行详情/编辑弹窗表单。
 * 打开即为规范表单，可直接查看并支持修改字段、保存、删除。
 */
export function RowDetail({ row, canEdit, onClose, onSaved, onDelete }: RowDetailProps) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    docDate: row.docDate ?? "",
    docNo: row.docNo ?? "",
    itemCode: row.itemCode ?? "",
    itemName: row.itemName ?? "",
    unit: row.unit ?? "",
    qty: row.qty === null ? "" : String(row.qty),
    price:
      row.priceMicros === null
        ? ""
        : (row.priceMicros / 10000).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""),
    amount:
      row.amountCents === null ? "" : (row.amountCents / 100).toFixed(2),
    remark: row.remark ?? "",
    owner: row.owner ?? "",
  });

  // 金额按分，单价按万分之一元
  const parseScaled = (raw: string, scale: number): number | undefined => {
    const cleaned = raw.replace(/[,，¥￥\s]/g, "");
    if (cleaned === "") return undefined;
    const number = Number(cleaned);
    return Number.isFinite(number) ? Math.round(number * scale) : undefined;
  };
  const parseCents = (raw: string) => parseScaled(raw, 100);
  const parseMicros = (raw: string) => parseScaled(raw, 10_000);

  // 数量或单价变动时，如用户未强制手输金额，可自动预估合计
  const handleQtyChange = (val: string) => {
    setDraft((prev) => {
      const next = { ...prev, qty: val };
      const q = Number(val);
      const p = Number(prev.price);
      if (val && prev.price && Number.isFinite(q) && Number.isFinite(p) && q >= 0 && p >= 0) {
        next.amount = (q * p).toFixed(2);
      }
      return next;
    });
  };

  const handlePriceChange = (val: string) => {
    setDraft((prev) => {
      const next = { ...prev, price: val };
      const q = Number(prev.qty);
      const p = Number(val);
      if (prev.qty && val && Number.isFinite(q) && Number.isFinite(p) && q >= 0 && p >= 0) {
        next.amount = (q * p).toFixed(2);
      }
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      await updateRow(row.id, {
        docDate: draft.docDate || null,
        docNo: draft.docNo || null,
        itemCode: draft.itemCode || null,
        itemName: draft.itemName || null,
        unit: draft.unit || null,
        qty: draft.qty === "" ? null : Number(draft.qty),
        priceMicros: parseMicros(draft.price) ?? null,
        amountCents: parseCents(draft.amount) ?? null,
        remark: draft.remark || null,
        owner: draft.owner || null,
      });
      toast("已保存修改", { description: `源表第 ${row.rowNo} 行`, status: "success" });
      await onSaved();
    } catch (err) {
      toast("保存失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onOpenChange={(open: boolean) => !open && onClose()} size="lg">
      <ModalHeader
        title={
          <div className="flex items-center gap-2">
            <span
              className={
                row.isReturn
                  ? "rounded bg-amber-500/12 px-2 py-0.5 text-caption-1-semibold text-amber-500"
                  : row.kind === "in"
                    ? "rounded bg-emerald-500/12 px-2 py-0.5 text-caption-1-semibold text-emerald-400"
                    : "rounded bg-sky-500/12 px-2 py-0.5 text-caption-1-semibold text-sky-400"
              }
            >
              {rowKindLabel(row)}
            </span>
            <span className="truncate">{row.itemName ?? row.itemCode ?? "台账明细"}</span>
          </div>
        }
        description={`源工作表：${row.sheet} · 第 ${row.rowNo} 行 · 导入批次 #${row.importId ?? "—"}${
          row.sourceDocNo ? ` · 原入库单 ${row.sourceDocNo}` : ""
        }`}
      />

      <ModalBody className="flex flex-col gap-4 py-2">
        {/* 数据异常提醒 */}
        {row.flags.length > 0 ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-amber-500">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-caption-1-semibold">这一行有数据提醒</p>
              <p className="mt-0.5 text-body-2-regular text-text-secondary">
                {row.flags.map(flagLabel).join(" · ")}
              </p>
            </div>
          </div>
        ) : null}

        {/* 核心核算数据区：数量、单价、金额并列 */}
        <div className="rounded-xl border border-border-button-default bg-background-secondary-default/50 p-4">
          <p className="text-caption-1-semibold text-text-tertiary mb-3">出入库核算数据</p>
          <div className="grid grid-cols-3 gap-3">
            <FormField label="数量">
              <Input
                size="small"
                type="number"
                value={draft.qty}
                onChange={handleQtyChange}
                isDisabled={!canEdit}
                placeholder="数量"
              />
            </FormField>
            <FormField label="单价（元）">
              <Input
                size="small"
                value={draft.price}
                onChange={handlePriceChange}
                isDisabled={!canEdit}
                placeholder="0.00"
              />
            </FormField>
            <FormField label="合计金额（元）">
              <Input
                size="small"
                value={draft.amount}
                onChange={(val) => setDraft({ ...draft, amount: val })}
                isDisabled={!canEdit}
                placeholder="0.00"
              />
            </FormField>
          </div>
        </div>

        {/* 物料信息 */}
        <div className="flex flex-col gap-3 rounded-xl border border-separator-border p-4">
          <p className="text-caption-1-semibold text-text-tertiary">物料信息</p>
          <FormField label="物料名称">
            <Input
              size="small"
              value={draft.itemName}
              onChange={(val) => setDraft({ ...draft, itemName: val })}
              isDisabled={!canEdit}
              placeholder="物料品名"
            />
          </FormField>
          <div className="grid grid-cols-3 gap-3">
            <FormField label="物料编码">
              <Input
                size="small"
                value={draft.itemCode}
                onChange={(val) => setDraft({ ...draft, itemCode: val })}
                isDisabled={!canEdit}
                placeholder="物料编码"
              />
            </FormField>
            <FormField label="规格型号">
              <Input
                size="small"
                value={row.spec ?? ""}
                isDisabled
                placeholder="规格型号（只读）"
              />
            </FormField>
            <FormField label="计量单位">
              <Input
                size="small"
                value={draft.unit}
                onChange={(val) => setDraft({ ...draft, unit: val })}
                isDisabled={!canEdit}
                placeholder="件/只/个"
              />
            </FormField>
          </div>
        </div>

        {/* 单据与往来 */}
        <div className="flex flex-col gap-3 rounded-xl border border-separator-border p-4">
          <p className="text-caption-1-semibold text-text-tertiary">单据与往来</p>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="日期">
              <Input
                size="small"
                value={draft.docDate}
                onChange={(val) => setDraft({ ...draft, docDate: val })}
                isDisabled={!canEdit}
                placeholder="YYYY-MM-DD"
              />
            </FormField>
            <FormField label="单据编号">
              <Input
                size="small"
                value={draft.docNo}
                onChange={(val) => setDraft({ ...draft, docNo: val })}
                isDisabled={!canEdit}
                placeholder="单据编号"
              />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="供应商">
              <Input
                size="small"
                value={row.partner ?? ""}
                isDisabled
                placeholder="供应商（源表）"
              />
            </FormField>
            <FormField label="送货单号">
              <Input
                size="small"
                value={row.deliveryNo ?? ""}
                isDisabled
                placeholder="送货单号"
              />
            </FormField>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <FormField label="归属部门/人">
              <Input
                size="small"
                value={draft.owner}
                onChange={(val) => setDraft({ ...draft, owner: val })}
                isDisabled={!canEdit}
                placeholder="归属"
              />
            </FormField>
            <FormField label="采购人">
              <Input
                size="small"
                value={row.buyer ?? ""}
                isDisabled
                placeholder="采购人"
              />
            </FormField>
            <FormField label="领用人">
              <Input
                size="small"
                value={row.receiver ?? ""}
                isDisabled
                placeholder="领用人"
              />
            </FormField>
          </div>
        </div>

        {/* 备注 */}
        <FormField label="备注说明">
          <Input
            size="small"
            value={draft.remark}
            onChange={(val) => setDraft({ ...draft, remark: val })}
            isDisabled={!canEdit}
            placeholder="填写备注说明..."
          />
        </FormField>

        {/* 来源记录底注 */}
        <div className="rounded-xl border border-separator-border bg-background-secondary-default/20 px-3.5 py-2.5 text-caption-1-regular text-text-tertiary">
          <span>来源记录：</span>
          <span className="font-mono text-text-secondary">
            {row.sheet} · 第 {row.rowNo} 行 · 批次 #{row.importId ?? "—"} · 录入于 {shortTs(row.createdAt)}
          </span>
        </div>
      </ModalBody>

      <ModalFooter className="flex items-center justify-between">
        {canEdit ? (
          <Button
            size="small"
            variant="ghost"
            leadingIcon={RiDeleteBinLine}
            onClick={() => onDelete(row)}
            className="text-text-destructive hover:bg-red-500/10 mr-auto"
          >
            删除该行
          </Button>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-2">
          <Button size="small" variant="secondary" onClick={onClose} disabled={busy}>
            {canEdit ? "取消" : "关闭"}
          </Button>
          {canEdit ? (
            <Button size="small" onClick={save} disabled={busy}>
              {busy ? "保存中..." : "保存修改"}
            </Button>
          ) : null}
        </div>
      </ModalFooter>
    </Modal>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption-1-semibold text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}
