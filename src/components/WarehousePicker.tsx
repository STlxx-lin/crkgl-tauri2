import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiPencilLine,
  RiStackLine,
} from "@remixicon/react";
import {
  createWarehouse,
  deleteWarehouse,
  fetchWarehouses,
  isTauri,
  listWarehouses,
  setRemoteWarehouse,
  switchWarehouse,
  updateWarehouse,
} from "../lib/api";
import type { Warehouse } from "../lib/types";
import { count } from "../lib/format";
import { cx } from "@/utils/cx";
import { Button } from "@/components/base/buttons/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";

const REMOTE_KEY = "ledger.warehouse.remote";

/**
 * 侧栏顶部的仓库切换器。
 *
 * 桌面端：切换只写 `settings.active_warehouse`，所有命令立刻跟着换仓；
 * 只读站：切换只改本地 localStorage，同事之间互不影响。
 *
 * 仓库的增改删只在桌面端提供——只读站没有任何写接口是硬边界。
 */
export function WarehousePicker({
  warehouses,
  activeId,
  onSwitch,
  onChanged,
}: {
  warehouses: Warehouse[];
  activeId: number;
  /** 切换仓库：参数是新仓库 id */
  onSwitch: (id: number) => void;
  /** 仓库档案变了（新建/改名/停用/删除），外面重新读一遍清单 */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const active = useMemo(
    () => warehouses.find((w) => w.id === activeId) ?? warehouses[0] ?? null,
    [warehouses, activeId],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !wrapRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const pick = async (id: number) => {
    setOpen(false);
    if (id === activeId) return;
    setBusy(true);
    try {
      if (isTauri) {
        await switchWarehouse(id);
      } else {
        rememberRemoteWarehouse(id);
      }
      onSwitch(id);
    } catch (err) {
      toast("切换仓库失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative px-2">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={busy || warehouses.length === 0}
        className={cx(
          "flex w-full items-center gap-2 rounded-lg border border-separator-border bg-background-primary-default px-2.5 py-2 text-start outline-none transition-colors",
          "hover:border-border-button-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        )}
      >
        <RiStackLine className="size-4 shrink-0 text-text-secondary" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-2-medium text-text-primary">
            {active?.name ?? "还没有仓库"}
          </span>
          <span className="block truncate text-caption-1-regular text-text-tertiary">
            {active ? `${count(active.ledgerRows)} 行台账` : "先新建一个仓库"}
          </span>
        </span>
        <RiArrowDownSLine
          className={cx("size-4 shrink-0 text-text-tertiary transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="切换仓库"
          className="absolute inset-x-2 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border-button-hover bg-background-primary-default p-1 shadow-2xl"
        >
          {warehouses.map((item) => {
            const selected = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => void pick(item.id)}
                className={cx(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-start transition-colors",
                  "hover:bg-dropdown-item-hover-background",
                  selected ? "text-text-primary" : "text-text-secondary",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-2-medium">{item.name}</span>
                  <span className="block truncate text-caption-1-regular text-text-tertiary">
                    {count(item.ledgerRows)} 行 · {count(item.vouchers)} 张单
                    {item.active ? "" : " · 已停用"}
                  </span>
                </span>
                {selected ? <RiCheckLine className="size-3.5 shrink-0" aria-hidden /> : null}
              </button>
            );
          })}

          {isTauri ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setManaging(true);
              }}
              className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-separator-border px-2.5 py-2 text-start text-body-2-medium text-text-secondary transition-colors hover:bg-dropdown-item-hover-background hover:text-text-primary"
            >
              <RiPencilLine className="size-4 shrink-0" aria-hidden />
              管理仓库…
            </button>
          ) : null}
        </div>
      ) : null}

      {managing ? (
        <ManageWarehousesDialog
          warehouses={warehouses}
          activeId={activeId}
          onClose={() => setManaging(false)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

/** 管理仓库：新建、改名、停用、删除。删除有数据的仓库要二次确认。 */
function ManageWarehousesDialog({
  warehouses,
  activeId,
  onClose,
  onChanged,
}: {
  warehouses: Warehouse[];
  activeId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [draftName, setDraftName] = useState("");
  const [draftRemark, setDraftRemark] = useState("");
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Warehouse | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<Warehouse[]>(warehouses);

  // 增删改后重新拉一遍：行数变化要立刻反映在列表上
  useEffect(() => {
    let alive = true;
    listWarehouses()
      .then((list) => {
        if (alive) setRows(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [refresh, warehouses]);

  const afterChange = useCallback(() => {
    setRefresh((n) => n + 1);
    onChanged();
  }, [onChanged]);

  const resetForm = () => {
    setEditing(null);
    setDraftName("");
    setDraftRemark("");
  };

  const submit = async () => {
    const name = draftName.trim();
    if (!name) {
      toast("仓库名称不能为空", { status: "error" });
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await updateWarehouse(editing.id, {
          name,
          remark: draftRemark.trim() || null,
          active: editing.active,
          sortNo: editing.sortNo,
        });
        toast("仓库已更新", { description: name, status: "success" });
      } else {
        await createWarehouse({ name, remark: draftRemark.trim() || null });
        toast("仓库已新建", { description: name, status: "success" });
      }
      resetForm();
      afterChange();
    } catch (err) {
      toast(editing ? "改名失败" : "新建失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (item: Warehouse) => {
    setBusy(true);
    try {
      await updateWarehouse(item.id, {
        name: item.name,
        remark: item.remark,
        active: !item.active,
        sortNo: item.sortNo,
      });
      afterChange();
    } catch (err) {
      toast("操作失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: Warehouse, force: boolean) => {
    setBusy(true);
    try {
      await deleteWarehouse(item.id, force);
      toast("仓库已删除", { description: item.name, status: "success" });
      setPendingDelete(null);
      afterChange();
    } catch (err) {
      // 后端有兜底：最后一个仓库不让删，有数据的仓要 force
      toast("删除失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  /** 上移 / 下移：按当前顺序重排 sort_no，列表顺序就是侧栏下拉的顺序。 */
  const move = async (index: number, dir: -1 | 1) => {
    const target = rows[index + dir];
    const current = rows[index];
    if (!target || !current) return;
    const next = [...rows];
    next[index + dir] = current;
    next[index] = target;
    setBusy(true);
    try {
      // 按列表顺序重写 sort_no：仓库不多，整表刷一遍最省心
      for (let i = 0; i < next.length; i += 1) {
        if (next[i].sortNo === i) continue;
        await updateWarehouse(next[i].id, {
          name: next[i].name,
          remark: next[i].remark,
          active: next[i].active,
          sortNo: i,
        });
      }
      setRows(next.map((row, i) => ({ ...row, sortNo: i })));
      afterChange();
    } catch (err) {
      toast("调整顺序失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal isOpen onOpenChange={(open: boolean) => !open && onClose()} size="md">
        {({ close }) => (
          <>
            <ModalHeader
              title="管理仓库"
              description="业务数据按仓库分开记，物料、供应商、字典全库通用。"
            />
            <ModalBody>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2 rounded-xl border border-separator-border bg-background-secondary-default p-3">
                  <p className="text-body-2-medium text-text-primary">
                    {editing ? `改名：${editing.name}` : "新建仓库"}
                  </p>
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submit();
                    }}
                    placeholder="仓库名称，例如：二号仓"
                    aria-label="仓库名称"
                    className="h-9 w-full rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-body-regular text-text-primary outline-none placeholder:text-text-tertiary hover:border-border-button-hover focus:border-border-focus-ring focus:ring-2 focus:ring-border-focus-ring/20"
                  />
                  <input
                    value={draftRemark}
                    onChange={(e) => setDraftRemark(e.target.value)}
                    placeholder="备注（可空）"
                    aria-label="仓库备注"
                    className="h-9 w-full rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-body-regular text-text-primary outline-none placeholder:text-text-tertiary hover:border-border-button-hover focus:border-border-focus-ring focus:ring-2 focus:ring-border-focus-ring/20"
                  />
                  <div className="flex items-center justify-end gap-2">
                    {editing ? (
                      <Button size="small" variant="secondary" onClick={resetForm} disabled={busy}>
                        取消
                      </Button>
                    ) : null}
                    <Button size="small" leadingIcon={editing ? RiCheckLine : RiAddLine} onClick={submit} disabled={busy}>
                      {editing ? "保存改名" : "新建"}
                    </Button>
                  </div>
                </div>

                <ul className="flex flex-col gap-1.5">
                  {rows.map((item, index) => {
                    const isActive = item.id === activeId;
                    const hasData = item.ledgerRows + item.vouchers + item.imports > 0;
                    return (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border-button-default bg-background-primary-default px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-body-2-medium text-text-primary">
                            <span className="truncate">{item.name}</span>
                            {isActive ? (
                              <span className="shrink-0 rounded bg-background-secondary-hover px-1.5 py-0.5 text-[0.6875rem] text-text-secondary">
                                当前
                              </span>
                            ) : null}
                            {item.active ? null : (
                              <span className="shrink-0 rounded bg-background-secondary-hover px-1.5 py-0.5 text-[0.6875rem] text-text-tertiary">
                                停用
                              </span>
                            )}
                          </p>
                          <p className="truncate text-caption-1-regular text-text-tertiary">
                            {count(item.ledgerRows)} 行 · {count(item.vouchers)} 张单 · {count(item.imports)} 次导入
                            {item.remark ? ` · ${item.remark}` : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="small"
                            variant="secondary"
                            iconOnly
                            leadingIcon={RiArrowUpLine}
                            aria-label={`上移 ${item.name}`}
                            title="上移"
                            onClick={() => void move(index, -1)}
                            disabled={busy || index === 0}
                          />
                          <Button
                            size="small"
                            variant="secondary"
                            iconOnly
                            leadingIcon={RiArrowDownLine}
                            aria-label={`下移 ${item.name}`}
                            title="下移"
                            onClick={() => void move(index, 1)}
                            disabled={busy || index === rows.length - 1}
                          />
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => {
                              setEditing(item);
                              setDraftName(item.name);
                              setDraftRemark(item.remark ?? "");
                            }}
                            disabled={busy}
                          >
                            改名
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => void toggleActive(item)}
                            disabled={busy || (item.active && !rows.some((w) => w.id !== item.id && w.active))}
                            title={item.active && !rows.some((w) => w.id !== item.id && w.active) ? "至少要保留一个启用的仓库" : undefined}
                          >
                            {item.active ? "停用" : "启用"}
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            leadingIcon={RiDeleteBinLine}
                            onClick={() => setPendingDelete(item)}
                            disabled={busy || rows.length <= 1}
                            title={rows.length <= 1 ? "至少要保留一个仓库" : undefined}
                          >
                            删除
                          </Button>
                        </div>
                        {hasData ? (
                          <p className="w-full text-[0.6875rem] text-text-tertiary">
                            有数据的仓库删除时会连台账、单据、导入记录一起删，基础资料不受影响。
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button size="small" variant="secondary" onClick={close} disabled={busy}>
                关闭
              </Button>
            </ModalFooter>
          </>
        )}
      </Modal>

      {pendingDelete ? (
        <Modal
          isOpen
          onOpenChange={(open: boolean) => !open && !busy && setPendingDelete(null)}
          size="sm"
          role="alertdialog"
        >
          {({ close }) => (
            <>
              <ModalHeader
                title={`删除仓库「${pendingDelete.name}」？`}
                description={
                  pendingDelete.ledgerRows + pendingDelete.vouchers + pendingDelete.imports > 0
                    ? `这个仓库还有 ${count(pendingDelete.ledgerRows)} 行台账、${count(pendingDelete.vouchers)} 张单据、${count(pendingDelete.imports)} 次导入，会一并删除。`
                    : "这个仓库还没有数据，删除不影响其他仓库。"
                }
                tone="danger"
                icon={RiDeleteBinLine}
              />
              <ModalBody>
                <p className="text-body-2-regular text-text-secondary">
                  物料、供应商、字典是全库通用的基础资料，不会跟着删除。
                </p>
              </ModalBody>
              <ModalFooter>
                <Button size="small" variant="secondary" onClick={close} disabled={busy}>
                  取消
                </Button>
                <Button
                  size="small"
                  variant="danger"
                  onClick={() => void remove(pendingDelete, true)}
                  disabled={busy}
                >
                  确认删除
                </Button>
              </ModalFooter>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}

/** 只读站启动时取仓库清单：桌面端用 bootstrap 里的那份，这里给浏览器兜底。 */
export async function loadRemoteWarehouses(): Promise<{ warehouses: Warehouse[]; activeWarehouseId: number }> {
  const saved = (() => {
    try {
      const n = Number(window.localStorage.getItem(REMOTE_KEY));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  })();
  const info = await fetchWarehouses();
  const exists = saved !== null && info.warehouses.some((w) => w.id === saved);
  const active = exists ? (saved as number) : info.activeWarehouseId;
  rememberRemoteWarehouse(active);
  return { warehouses: info.warehouses, activeWarehouseId: active };
}

/**
 * 只读站记住自己选的仓：内存里的 api 层 + localStorage。
 * 桌面端删了这个仓之后，App 用它回落到还存在的那个仓，免得一直发无效 id。
 */
export function rememberRemoteWarehouse(id: number): void {
  setRemoteWarehouse(id);
  try {
    window.localStorage.setItem(REMOTE_KEY, String(id));
  } catch {
    // 存不下也不影响本次会话
  }
}
