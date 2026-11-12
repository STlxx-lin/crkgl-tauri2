import { useEffect, useRef, useState } from "react";
import { RiAddLine, RiCheckLine } from "@remixicon/react";
import { createItem, createSupplier, isTauri, lookupItem } from "../lib/api";
import type { Item, Supplier } from "../lib/types";
import { Button } from "@/components/base/buttons/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";
import { ItemCatalog } from "./ItemCatalog";

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
  const [unit, setUnit] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  // 编码一敲就查：命中说明基础资料里已经有了，不用重复新建
  const [existing, setExisting] = useState<Item | null>(null);
  const [checking, setChecking] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // 打开就把光标放到第一个框，接着敲就行
  useEffect(() => {
    const t = window.setTimeout(() => codeRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  // 按编码精确查一次：命中只用来拦住「重复新建」
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

  // 编码已经存在时不能再建：后端也会因为唯一约束拒绝
  const canSave = isItem
    ? code.trim() !== "" && name.trim() !== "" && existing === null && !checking
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
        await createItem({
          itemCode: code.trim(),
          itemName: name.trim(),
          unit: unit.trim() || null,
          priceMicros: Number.isFinite(priceMicros) ? priceMicros : null,
          active: true,
        });
        const item: Item = {
          id: 0,
          itemCode: code.trim(),
          itemName: name.trim(),
          category: null,
          unit: unit.trim() || null,
          priceMicros: Number.isFinite(priceMicros) ? priceMicros : null,
          spec: null,
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
      toast(isItem ? "物料新增失败" : "供应商新增失败", {
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
            title={isItem ? "快速新增物料" : "快速新增供应商"}
            description={isItem ? "编码与名称必填，其余可以之后在基础资料里补。" : "名称必填。"}
          />
          <ModalBody className="flex-1">
            {/* 左录入、右清单：右边固定摊开基础资料里的物料，点一条就用 */}
            <div className={isItem ? "grid grid-cols-[minmax(0,1fr)_20rem] gap-4" : "flex flex-col gap-3"}>
              <div className="flex min-w-0 flex-col gap-3">
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
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-caption-1-semibold text-text-tertiary">单位</span>
                    <input
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                      placeholder="个 / 件 / 米"
                      className={field}
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

              {/* 右栏：基础资料里现有的物料，只作对照查看，不参与点击 */}
              {isItem ? (
                <ItemCatalog
                  keyword={code.trim() || name.trim()}
                  hint={existing ? "这个编码已经建过档，不用重复新建" : null}
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
            {existing && isItem ? (
              // 已经建过档就不用再新建，直接把它填进单据
              <Button size="small" leadingIcon={RiCheckLine} onClick={useExisting} disabled={!isTauri}>
                直接用这条物料
              </Button>
            ) : (
              <Button size="small" leadingIcon={RiAddLine} onClick={save} disabled={!canSave || busy || !isTauri}>
                {busy ? "保存中" : "保存"}
              </Button>
            )}
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
