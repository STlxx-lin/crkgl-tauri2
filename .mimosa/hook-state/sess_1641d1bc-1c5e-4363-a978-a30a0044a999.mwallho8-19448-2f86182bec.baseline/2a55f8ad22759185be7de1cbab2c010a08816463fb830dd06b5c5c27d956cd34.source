import { useState } from "react";
import { RiDeleteBinLine, RiPencilLine } from "@remixicon/react";
import type { LedgerRow } from "../lib/types";
import { date, flagLabel, kindLabel, money, priceText, qty, shortTs } from "../lib/format";
import { updateRow } from "../lib/api";
import { Button } from "@/components/base/buttons/button";
import { Drawer, DrawerBody, DrawerHeader } from "@/components/base/drawer/drawer";
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
 * 单行详情抽屉。平时是只读字段表；点「改这一行」才把可改的几项变成输入框。
 * 源表行号与来源表始终显示，方便回 Excel 对账。
 */
export function RowDetail({ row, canEdit, onClose, onSaved, onDelete }: RowDetailProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    docDate: row.docDate ?? "",
    docNo: row.docNo ?? "",
    itemCode: row.itemCode ?? "",
    itemName: row.itemName ?? "",
    unit: row.unit ?? "",
    qty: row.qty === null ? "" : String(row.qty),
    price: row.priceMicros === null ? "" : (row.priceMicros / 10000).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""),
    amount: row.amountCents === null ? "" : (row.amountCents / 10000).toFixed(4),
    remark: row.remark ?? "",
    owner: row.owner ?? "",
  });

  // 金额按分，单价按万分之一元：两者精度不同，不能共用一个换算
  const parseScaled = (raw: string, scale: number): number | undefined => {
    const cleaned = raw.replace(/[,，¥￥\s]/g, "");
    if (cleaned === "") return undefined;
    const number = Number(cleaned);
    return Number.isFinite(number) ? Math.round(number * scale) : undefined;
  };
  const parseCents = (raw: string) => parseScaled(raw, 100);
  const parseMicros = (raw: string) => parseScaled(raw, 10_000);

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
      toast("已保存", { description: `源表第 ${row.rowNo} 行`, status: "success" });
      setEditing(false);
      await onSaved();
    } catch (err) {
      toast("保存失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer isOpen onOpenChange={(open: boolean) => !open && onClose()} placement="end" size="md">
      <DrawerHeader
        title={kindLabel(row.kind) + " · " + (row.itemName ?? row.itemCode ?? "")}
        description={`${row.sheet} 第 ${row.rowNo} 行 · ${date(row.docDate)}`}
      />
      <DrawerBody className="flex flex-col gap-5">
        {row.flags.length > 0 ? (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2.5">
            <p className="text-caption-1-semibold text-amber-500">这一行有数据提醒</p>
            <p className="mt-1 text-body-2-regular text-text-secondary">
              {row.flags.map(flagLabel).join(" · ")}
            </p>
          </div>
        ) : null}

        <section className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="日期" value={date(row.docDate)} mono />
          <Field label="单据编号" value={row.docNo ?? "—"} mono />
          <Field label="送货单号" value={row.deliveryNo ?? "—"} mono />
          <Field label="物料编码" value={row.itemCode ?? "—"} mono />
          <div className="col-span-2">
            <Field label="物料名称" value={row.itemName ?? "—"} />
          </div>
          <Field label="单位" value={row.unit ?? "—"} />
          <Field label="数量" value={qty(row.qty)} mono align="end" />
          <Field label="单价" value={row.priceMicros === null ? "—" : priceText(row.priceMicros)} mono align="end" />
          <Field label="合计" value={money(row.amountCents)} mono align="end" strong />
          <Field label="供应商" value={row.partner ?? "—"} />
          <Field label="采购人" value={row.buyer ?? "—"} />
          <Field label="归属" value={row.owner ?? "—"} />
          <Field label="领用人" value={row.receiver ?? "—"} />
          <div className="col-span-2">
            <Field label="备注" value={row.remark ?? "—"} />
          </div>
        </section>

        <section className="rounded-xl border border-separator-border px-3 py-2.5">
          <p className="text-caption-1-semibold text-text-tertiary">来源</p>
          <p className="mt-1 font-mono text-body-2-regular tabular-nums text-text-secondary">
            {row.sheet} · 第 {row.rowNo} 行 · 导入批次 #{row.importId ?? "—"} · {shortTs(row.createdAt)}
          </p>
        </section>

        {editing ? (
          <section className="flex flex-col gap-3 rounded-xl border border-separator-border p-3">
            <p className="text-caption-1-semibold text-text-tertiary">改这一行（只影响本机台账）</p>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="日期">
                <Input size="small" value={draft.docDate} onChange={(value) => setDraft({ ...draft, docDate: value })} />
              </Labeled>
              <Labeled label="单据编号">
                <Input size="small" value={draft.docNo} onChange={(value) => setDraft({ ...draft, docNo: value })} />
              </Labeled>
              <Labeled label="物料编码">
                <Input size="small" value={draft.itemCode} onChange={(value) => setDraft({ ...draft, itemCode: value })} />
              </Labeled>
              <Labeled label="单位">
                <Input size="small" value={draft.unit} onChange={(value) => setDraft({ ...draft, unit: value })} />
              </Labeled>
              <Labeled label="数量">
                <Input size="small" value={draft.qty} onChange={(value) => setDraft({ ...draft, qty: value })} />
              </Labeled>
              <Labeled label="单价（元）">
                <Input size="small" value={draft.price} onChange={(value) => setDraft({ ...draft, price: value })} />
              </Labeled>
              <Labeled label="合计（元）">
                <Input size="small" value={draft.amount} onChange={(value) => setDraft({ ...draft, amount: value })} />
              </Labeled>
              <Labeled label="归属">
                <Input size="small" value={draft.owner} onChange={(value) => setDraft({ ...draft, owner: value })} />
              </Labeled>
            </div>
            <Labeled label="物料名称">
              <Input size="small" value={draft.itemName} onChange={(value) => setDraft({ ...draft, itemName: value })} />
            </Labeled>
            <Labeled label="备注">
              <Input size="small" value={draft.remark} onChange={(value) => setDraft({ ...draft, remark: value })} />
            </Labeled>
            <div className="flex items-center justify-end gap-2">
              <Button size="small" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                取消
              </Button>
              <Button size="small" onClick={save} disabled={busy}>
                {busy ? "保存中" : "保存"}
              </Button>
            </div>
          </section>
        ) : null}

        {canEdit ? (
          <div className="flex items-center gap-2 border-t border-separator-border pt-4">
            {editing ? null : (
              <Button size="small" variant="secondary" leadingIcon={RiPencilLine} onClick={() => setEditing(true)}>
                改这一行
              </Button>
            )}
            <Button
              size="small"
              variant="secondary"
              leadingIcon={RiDeleteBinLine}
              onClick={() => onDelete(row)}
              className="ms-auto text-text-destructive"
            >
              删除
            </Button>
          </div>
        ) : null}
      </DrawerBody>
    </Drawer>
  );
}

function Field({
  label,
  value,
  mono,
  strong,
  align,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
  align?: "end";
}) {
  return (
    <div className={align === "end" ? "text-end" : undefined}>
      <p className="text-caption-1-semibold text-text-tertiary">{label}</p>
      <p
        className={
          "mt-0.5 break-words " +
          (mono ? "font-mono tabular-nums " : "") +
          (strong ? "text-body-medium text-text-primary" : "text-body-2-medium text-text-secondary")
        }
      >
        {value}
      </p>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption-1-semibold text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}
