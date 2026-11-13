import { useEffect, useRef, useState } from "react";
import { RiAddLine, RiCheckLine } from "@remixicon/react";
import { createItem, createSupplier, isTauri, listDict, lookupItem, updateItem } from "../lib/api";
import type { Item, ItemInput, Supplier } from "../lib/types";
import { Button } from "@/components/base/buttons/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";
import { ItemCatalog } from "./ItemCatalog";
import { ModalDropdown } from "./ModalDropdown";

/**
 * 开单页的「快速新增」：录单到一半发现物料或供应商还没建档，
 * 不用切去基础资料页，就地补一条。
 *
 * 只收必要字段（物料：编码、名称、单位、参考单价；供应商：名称），
 * 其余信息之后在基础资料里慢慢补——否则这个弹窗就跟基础资料那张表一样长了。
 */
export type QuickAddKind = "item" | "supplier";

export function QuickAddDialog({
  kind,
  onClose,
  onCreated,
}: {
  kind: QuickAddKind;
  /** 关闭弹窗 */
  onClose: () => void;
  /** 建好后把新记录交给调用方（可以直接填进当前单据） */
  onCreated: (record: { item?: Item; supplier?: Supplier }) => void;
}) {
  const isItem = kind === "item";
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [unit, setUnit] = useState("");
  const [price, setPrice] = useState("");
  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // 当前正在编辑的物料记录（从右侧物料清单点入）
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  // 编码一敲就查：命中说明基础资料里已经有了，不用重复新建
  const [existing, setExisting] = useState<Item | null>(null);
  const [checking, setChecking] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // 从字典加载单位候选
  useEffect(() => {
    if (!isItem || !isTauri) return;
    let alive = true;
    listDict("unit", undefined, true)
      .then((entries) => {
        if (alive) setUnitOptions(entries.map((e) => e.value));
      })
      .catch(() => {
        if (alive) setUnitOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [isItem]);

  // 打开就把光标放到第一个框，接着敲就行
  useEffect(() => {
    const t = window.setTimeout(() => codeRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  // 载入右侧物料进入编辑模式
  const handleSelectForEdit = (item: Item) => {
    setEditingItem(item);
    setCode(item.itemCode);
    setName(item.itemName);
    setSpec(item.spec ?? "");
    setUnit(item.unit ?? "");
    setPrice(item.priceMicros != null ? String(item.priceMicros / 10_000) : "");
  };

  // 切回新建模式
  const resetToCreate = () => {
    setEditingItem(null);
    setCode("");
    setName("");
    setSpec("");
    setUnit("");
    setPrice("");
    setExisting(null);
    codeRef.current?.focus();
  };

  // 按编码精确查一次：命中只用来拦住「重复新建」或占用其他物料编码
  useEffect(() => {
    const typed = code.trim();
    if (!isItem || !isTauri || typed === "") {
      setExisting(null);
      setChecking(false);
      return;
    }
    let alive = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      lookupItem(typed)
        .then((hit) => {
          if (alive) setExisting(hit);
        })
        .catch(() => {
          if (alive) setExisting(null);
        })
        .finally(() => {
          if (alive) setChecking(false);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [code, isItem]);

  // 编辑模式下自身编码不构成冲突；只有占用了其他物料的编码时才拦截
  const isConflict =
    existing !== null && (!editingItem || existing.id !== editingItem.id);

  const canSave = isItem
    ? code.trim() !== "" && name.trim() !== "" && !isConflict && !checking
    : name.trim() !== "";

  /** 编码已存在时，直接把那条物料拿去用，不新建。 */
  const useExisting = () => {
    if (!existing) return;
    onCreated({ item: existing });
    onClose();
  };

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      if (isItem) {
        const priceMicros = price.trim() === "" ? null : Math.round(Number(price) * 10_000);
        const validPrice = Number.isFinite(priceMicros) ? priceMicros : null;

        if (editingItem) {
          // 修改已有物料：保留原有分类、库位、图号等扩展信息
          const itemInput: ItemInput = {
            ...editingItem,
            itemCode: code.trim(),
            itemName: name.trim(),
            spec: spec.trim() || null,
            unit: unit.trim() || null,
            priceMicros: validPrice,
          };
          await updateItem(editingItem.id, itemInput);
          const updated: Item = {
            ...editingItem,
            itemCode: code.trim(),
            itemName: name.trim(),
            spec: spec.trim() || null,
            unit: unit.trim() || null,
            priceMicros: validPrice,
          };
          toast("物料已修改", { description: `${updated.itemCode} ${updated.itemName}`, status: "success" });
          onCreated({ item: updated });
        } else {
          // 新增物料
          await createItem({
            itemCode: code.trim(),
            itemName: name.trim(),
            spec: spec.trim() || null,
            unit: unit.trim() || null,
            priceMicros: validPrice,
            active: true,
          });
          const item: Item = {
            id: 0,
            itemCode: code.trim(),
            itemName: name.trim(),
            category: null,
            unit: unit.trim() || null,
            priceMicros: validPrice,
            spec: spec.trim() || null,
            itemType: null,
            drawingNo: null,
            owner: null,
            supplier: null,
            remark: null,
            location: null,
            active: true,
          };
          toast("物料已新增", { description: `${item.itemCode} ${item.itemName}`, status: "success" });
          onCreated({ item });
        }
      } else {
        const supplier: Supplier = {
          id: 0,
          name: name.trim(),
          contact: null,
          phone: null,
          remark: null,
          active: true,
          hits: 0,
        };
        await createSupplier({ name: supplier.name, active: true });
        toast("供应商已新增", { description: supplier.name, status: "success" });
        onCreated({ supplier });
      }
      onClose();
    } catch (err) {
      toast(isItem ? (editingItem ? "物料修改失败" : "物料新增失败") : "供应商新增失败", {
        description: String(err),
        status: "error",
        duration: 7000,
      });
    } finally {
      setBusy(false);
    }
  };

  const field =
    "h-9 w-full rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-body-regular text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-focus-ring";

  return (
    <Modal
      isOpen
      onOpenChange={(open: boolean) => !open && !busy && onClose()}
      size="xl"
      className="max-h-[86vh] w-[880px] max-w-[92vw] overflow-y-auto"
    >
      {({ close }) => (
        <div className="flex min-h-full flex-col">
          <ModalHeader
            title={!isItem ? "快速新增供应商" : editingItem ? "编辑物料" : "快速新增物料"}
            description={
              !isItem
                ? "名称必填。"
                : editingItem
                ? `正在修改物料档案「${editingItem.itemCode}」，保存后将同步更新物料档案与开单明细。`
                : "编码与名称必填，其余可以之后在基础资料里补。"
            }
          />
          <ModalBody className="flex-1">
            {/* 左录入、右清单：右边固定摊开基础资料里的物料，点一条即可载入编辑 */}
            <div className={isItem ? "grid grid-cols-[minmax(0,1fr)_20rem] gap-4" : "flex flex-col gap-3"}>
              <div className="flex min-w-0 flex-col gap-3">
              {editingItem ? (
                <div className="flex items-center justify-between rounded-lg border border-border-focus-ring/30 bg-background-tertiary-default px-2.5 py-1.5 text-caption-1-regular">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="size-2 rounded-full bg-emerald-500 shrink-0" />
                    <span className="truncate text-text-secondary">
                      正在编辑：<strong className="font-medium text-text-primary">{editingItem.itemCode}</strong>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={resetToCreate}
                    className="shrink-0 font-medium text-caption-1-medium text-text-brand hover:underline"
                  >
                    + 切回新增
                  </button>
                </div>
              ) : null}

              {isItem ? (
                <label className="flex flex-col gap-1">
                  <span className="text-caption-1-semibold text-text-tertiary">物料编码 *</span>
                  <input
                    ref={codeRef}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="如 WG-QDL-0042"
                    className={field}
                  />
                </label>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="text-caption-1-semibold text-text-tertiary">
                  {isItem ? "物料名称 *" : "供应商名称 *"}
                </span>
                <input
                  ref={isItem ? undefined : codeRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={isItem ? "如 亚德客气缸AR2001" : "如 亚德客（中国）有限公司"}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save();
                  }}
                  className={field}
                />
              </label>

              {isItem ? (
                <label className="flex flex-col gap-1">
                  <span className="text-caption-1-semibold text-text-tertiary">规格型号</span>
                  <input
                    value={spec}
                    onChange={(e) => setSpec(e.target.value)}
                    placeholder="如 AR2001-02BG 或 Φ12*30"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void save();
                    }}
                    className={field}
                  />
                </label>
              ) : null}

              {isItem ? (
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-caption-1-semibold text-text-tertiary">单位</span>
                    <ModalDropdown
                      label="单位"
                      value={unit}
                      onChange={(v) => setUnit(v)}
                      options={unitOptions}
                      placeholder="选或输入单位"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-caption-1-semibold text-text-tertiary">参考单价（元）</span>
                    <input
                      inputMode="decimal"
                      value={price}
                      onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="0.00"
                      className={field}
                    />
                  </label>
                </div>
              ) : null}
              </div>

              {/* 右栏：基础资料里现有的物料，点击可载入左侧直接编辑 */}
              {isItem ? (
                <ItemCatalog
                  keyword={code.trim() || name.trim() || spec.trim()}
                  hint={
                    isConflict
                      ? "这个编码已被其他物料占用"
                      : existing && !editingItem
                      ? "这个编码已经建过档，右侧点击可载入编辑"
                      : null
                  }
                  onSelect={handleSelectForEdit}
                  selectedId={editingItem?.id}
                />
              ) : (
                <div className="rounded-xl border border-separator-border bg-background-secondary-default px-3 py-2.5">
                  <p className="text-caption-1-semibold text-text-tertiary">保存后会加到单据上</p>
                  <dl className="mt-1.5 flex flex-col gap-1 text-body-2-regular">
                    <PreviewRow label="供应商" value={name} placeholder="未填" />
                  </dl>
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button size="small" variant="secondary" onClick={close} disabled={busy}>
              取消
            </Button>
            {existing && !editingItem && isItem ? (
              // 新建模式下如果编码已存在，可直接填进单据
              <Button size="small" leadingIcon={RiCheckLine} onClick={useExisting} disabled={!isTauri}>
                直接用这条物料
              </Button>
            ) : null}
            <Button
              size="small"
              leadingIcon={editingItem ? RiCheckLine : RiAddLine}
              onClick={save}
              disabled={!canSave || busy || !isTauri}
            >
              {busy ? "保存中" : editingItem ? "保存修改" : "保存"}
            </Button>
          </ModalFooter>
        </div>
      )}
    </Modal>
  );
}

/** 预览里的一行：标签 + 当前值（没填时用浅灰占位）。 */
function PreviewRow({ label, value, placeholder }: { label: string; value: string; placeholder: string }) {
  const text = value.trim();
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-14 shrink-0 text-caption-1-regular text-text-tertiary">{label}</dt>
      <dd className={text ? "min-w-0 flex-1 truncate text-text-primary" : "min-w-0 flex-1 truncate text-text-tertiary"}>
        {text || placeholder}
      </dd>
    </div>
  );
}
