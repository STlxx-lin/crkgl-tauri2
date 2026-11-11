import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiPencilLine,
  RiRefreshLine,
  RiSearchLine,
} from "@remixicon/react";
import {
  createDict,
  deleteDict,
  isTauri,
  listDict,
  syncDict,
  updateDict,
} from "../lib/api";
import { DICT_KINDS } from "../lib/types";
import type { DictEntry, DictInput, DictKind } from "../lib/types";
import { count } from "../lib/format";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { SearchField } from "@/components/base/search-field/search-field";
import { Switch } from "@/components/base/switch/switch";
import { SegmentedControl, SegmentedControlItem } from "@/components/base/segmented-control/segmented-control";
import { AlertDialog, Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";
import { Spinner } from "@/components/base/spinner/spinner";
import { EmptyState } from "./EmptyState";

/**
 * 字典：单位 / 类别 / 类型 / 出库部门 / 采购人。
 *
 * 这五类原来都是自由文本，开单时现查历史值拼下拉，同一个部门写成两种就分成两组。
 * 现在集中在 `dict` 表里维护：改名会同步改写台账与物料，停用只是不再出现在下拉里，
 * 删除要求先没人用——避免台账里留下一串指向不存在字典项的值。
 */
export function DictPanel({ onChanged }: { onChanged: () => void }) {
  const [kind, setKind] = useState<DictKind>("unit");
  const [keyword, setKeyword] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [rows, setRows] = useState<DictEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<DictEntry | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DictEntry | null>(null);
  const seq = useRef(0);

  const meta = useMemo(() => DICT_KINDS.find((k) => k.kind === kind)!, [kind]);
  const label = meta.label;
  const handle = meta.kind === "owner" ? "出库部门（台账里的「归属」）" : label;

  const load = useCallback(async () => {
    if (!isTauri) return;
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const list = await listDict(kind, keyword.trim() || undefined, onlyActive);
      if (ticket === seq.current) setRows(list);
    } catch (err) {
      toast("字典读取失败", { description: String(err), status: "error" });
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [kind, keyword, onlyActive]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const doSync = async () => {
    try {
      const added = await syncDict();
      toast(added > 0 ? `已补 ${count(added)} 条` : "字典已是最新", {
        description: added > 0 ? "从物料与台账里读到的值已登记" : "现有数据里的值都已在字典里",
        status: "success",
      });
      await load();
      onChanged();
    } catch (err) {
      toast("补齐失败", { description: String(err), status: "error" });
    }
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteDict(pendingDelete.id);
      toast("已删除", { description: pendingDelete.value });
      setPendingDelete(null);
      await load();
      onChanged();
    } catch (err) {
      // 还有行在用时会拒绝，原话给出去（比通用「删除失败」有用）
      toast("删除失败", { description: String(err), status: "error" });
      setPendingDelete(null);
    }
  };

  const inUse = useMemo(() => rows.filter((r) => r.used > 0).length, [rows]);

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label="字段字典"
          selectedKeys={[kind]}
          onSelectionChange={(keys) => {
            const next = Array.from(keys)[0];
            if (next) {
              setKind(String(next) as DictKind);
              setKeyword("");
            }
          }}
        >
          {DICT_KINDS.map((entry) => (
            <SegmentedControlItem key={entry.kind} id={entry.kind}>
              {entry.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <SearchField
          aria-label={`搜索${label}`}
          placeholder={`搜${label}`}
          size="small"
          shape="rounded"
          value={keyword}
          onChange={setKeyword}
          className="w-52"
        />
        <label className="flex items-center gap-2 text-body-2-regular text-text-secondary">
          <Switch size="sm" isSelected={onlyActive} onChange={setOnlyActive} aria-label="只看在用" />
          只看在用
        </label>
        {loading ? <Spinner size="xs" aria-label="加载中" /> : null}
        <Button
          size="small"
          variant="ghost"
          leadingIcon={RiRefreshLine}
          onClick={doSync}
          disabled={loading || !isTauri}
          title="从物料与台账现有数据里补登记缺的值"
        >
          从数据补齐
        </Button>
        <Button
          size="small"
          leadingIcon={RiAddLine}
          onClick={() => setEditing("new")}
          className="ms-auto"
          disabled={!isTauri}
        >
          新增{label}
        </Button>
      </div>

      <p className="text-caption-1-regular text-text-tertiary">
        {handle} · 共 {count(rows.length)} 条，其中 {count(inUse)} 条已被数据引用。
        改名会同步改写台账与物料里用到它的行；还在用的条目只能停用，不能删。
      </p>

      <div className="overflow-x-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[760px] table-fixed border-collapse text-[0.8125rem]">
          <thead>
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="px-3 py-2 text-start font-medium whitespace-nowrap">{label}</th>
              <th className="w-[100px] px-3 py-2 text-end font-medium whitespace-nowrap font-mono tabular-nums">使用行数</th>
              <th className="w-[76px] px-3 py-2 text-end font-medium whitespace-nowrap font-mono tabular-nums">排序</th>
              <th className="w-[120px] px-3 py-2 text-start font-medium whitespace-nowrap">备注</th>
              <th className="w-[76px] px-3 py-2 text-center font-medium whitespace-nowrap">状态</th>
              <th className="w-[88px] px-3 py-2 text-end font-medium whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12">
                  <EmptyState
                    icon={RiSearchLine}
                    title={keyword.trim() ? `没有匹配的${label}` : `还没有${label}字典`}
                    description={
                      keyword.trim()
                        ? "换个关键字，或把「只看在用」关掉。"
                        : "点「新增」手工加，或点「从数据补齐」把现有数据里的值收进来。"
                    }
                  />
                </td>
              </tr>
            ) : (
              rows.map((entry) => (
                <tr key={entry.id} className="border-b border-separator-border last:border-0 hover:bg-background-secondary-hover">
                  <td className="truncate px-3 py-1.5 text-text-primary" title={entry.value}>
                    {entry.value}
                  </td>
                  <td className="px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary whitespace-nowrap">
                    {entry.used > 0 ? count(entry.used) : <span className="text-text-tertiary">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-end font-mono tabular-nums text-text-tertiary whitespace-nowrap">
                    {entry.sortNo === 0 ? "—" : entry.sortNo}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary" title={entry.remark ?? ""}>
                    {entry.remark ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-center whitespace-nowrap">
                    <span
                      className={
                        entry.active
                          ? "text-caption-1-semibold text-emerald-500"
                          : "text-caption-1-regular text-text-tertiary"
                      }
                    >
                      {entry.active ? "在用" : "停用"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-end whitespace-nowrap">
                    <button
                      type="button"
                      aria-label={`编辑 ${entry.value}`}
                      onClick={() => setEditing(entry)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
                    >
                      <RiPencilLine className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`删除 ${entry.value}`}
                      onClick={() => setPendingDelete(entry)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-destructive"
                    >
                      <RiDeleteBinLine className="size-3.5" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <DictDialog
          kind={kind}
          entry={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            onChanged();
          }}
        />
      ) : null}

      <AlertDialog
        title={`删除${label}`}
        description={
          pendingDelete
            ? pendingDelete.used > 0
              ? `「${pendingDelete.value}」还有 ${count(pendingDelete.used)} 行在用，删不掉。改成停用，或先把那些行改掉。`
              : `将删除「${pendingDelete.value}」，没有数据在用它。`
            : ""
        }
        confirmLabel="删除"
        onConfirm={doDelete}
        isOpen={pendingDelete !== null}
        onOpenChange={(open: boolean) => !open && setPendingDelete(null)}
        variant="danger"
      />
    </div>
  );
}

function DictDialog({
  kind,
  entry,
  onClose,
  onSaved,
}: {
  kind: DictKind;
  entry: DictEntry | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const label = DICT_KINDS.find((k) => k.kind === kind)?.label ?? "字典";
  const [form, setForm] = useState<DictInput>({
    kind,
    value: entry?.value ?? "",
    sortNo: entry?.sortNo ?? 0,
    remark: entry?.remark ?? "",
    active: entry?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof DictInput>(key: K, value: DictInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      if (entry) {
        const touched = await updateDict(entry.id, form);
        toast("字典已更新", {
          description:
            touched > 0
              ? `${entry.value} → ${form.value.trim()}，同步改了 ${count(touched)} 行数据`
              : form.value,
          status: "success",
        });
      } else {
        await createDict(form);
        toast(`已新增${label}`, { description: form.value, status: "success" });
      }
      await onSaved();
    } catch (err) {
      toast("保存失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onOpenChange={(open: boolean) => !open && onClose()} size="sm">
      {({ close }) => (
        <>
          <ModalHeader
            title={entry ? `编辑${label}` : `新增${label}`}
            description={entry ? "改名会同步改写台账与物料里用到它的行" : undefined}
          />
          <ModalBody className="flex flex-col gap-3">
            <Labeled label={label}>
              <Input
                size="small"
                autoFocus
                value={form.value}
                onChange={(v) => set("value", v)}
                placeholder={`输入${label}`}
              />
            </Labeled>
            <Labeled label="排序（0 = 按使用次数排）">
              <Input
                size="small"
                value={String(form.sortNo ?? 0)}
                onChange={(v) => {
                  const n = Number(v.replace(/[^\d-]/g, ""));
                  set("sortNo", Number.isFinite(n) ? n : 0);
                }}
              />
            </Labeled>
            <Labeled label="备注">
              <Input size="small" value={form.remark ?? ""} onChange={(v) => set("remark", v)} />
            </Labeled>
            <label className="flex items-center gap-2 text-body-2-regular text-text-secondary">
              <Switch
                size="sm"
                isSelected={form.active ?? true}
                onChange={(v) => set("active", v)}
                aria-label="在用"
              />
              在用（停用后不出现在开单下拉里，历史数据不受影响）
            </label>
          </ModalBody>
          <ModalFooter>
            <Button size="small" variant="secondary" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button size="small" onClick={save} disabled={busy || !form.value.trim()}>
              {busy ? "保存中" : "保存"}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
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
