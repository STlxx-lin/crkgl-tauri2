import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiDownload2Line,
  RiFileExcel2Line,
  RiPencilLine,
  RiRefreshLine,
  RiSearchLine,
} from "@remixicon/react";
import {
  backfillMaster,
  countItems,
  createItem,
  createSupplier,
  deleteItem,
  deleteSupplier,
  importMasterWorkbook,
  isTauri,
  listItems,
  listSuppliers,
  masterStats,
  updateItem,
  updateSupplier,
} from "../lib/api";
import type { Item, ItemInput, MasterStats, Supplier, SupplierInput } from "../lib/types";
import { count, priceText } from "../lib/format";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { SearchField } from "@/components/base/search-field/search-field";
import { Select, SelectItem } from "@/components/base/select/select";
import { ComboPicker } from "../components/ComboPicker";
import { Switch } from "@/components/base/switch/switch";
import { SegmentedControl, SegmentedControlItem } from "@/components/base/segmented-control/segmented-control";
import { Tabs, Tab, TabList, TabPanel } from "@/components/base/tabs/tabs";
import { AlertDialog, Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";
import { Spinner } from "@/components/base/spinner/spinner";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";

const PAGE = 100;

/** 基础资料：物料主数据 + 供应商。这两张表是开单时的字典。 */
export function MasterScreen({ onChanged }: { onChanged: () => void }) {
  const [tab, setTab] = useState<string>("items");
  const [stats, setStats] = useState<MasterStats | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStats = useCallback(async () => {
    if (!isTauri) return;
    try {
      setStats(await masterStats());
    } catch (err) {
      toast("统计读取失败", { description: String(err), status: "error" });
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const doImport = async () => {
    if (!isTauri) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      title: "选择含物料编号/供应商名称的工作簿",
      filters: [{ name: "Excel 工作簿", extensions: ["xlsm", "xlsx"] }],
    });
    if (typeof picked !== "string" || !picked) return;
    setBusy(true);
    try {
      const outcome = await importMasterWorkbook(picked);
      toast("主数据已导入", {
        description: `物料 +${count(outcome.itemsAdded)} / 更新 ${count(outcome.itemsUpdated)}，供应商 +${count(outcome.suppliersAdded)}`,
        status: "success",
        duration: 7000,
      });
      await loadStats();
      onChanged();
    } catch (err) {
      toast("导入失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const doBackfill = async () => {
    setBusy(true);
    try {
      const [items, suppliers] = await backfillMaster();
      toast("已从台账补齐", { description: `物料 +${count(items)}，供应商 +${count(suppliers)}`, status: "success" });
      await loadStats();
    } catch (err) {
      toast("补齐失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="基础资料"
        description="物料与供应商是开单时的字典：选物料带出单位与参考单价，供应商从下拉里挑"
        actions={
          <>
            <Button size="small" variant="secondary" leadingIcon={RiDownload2Line} onClick={doBackfill} disabled={busy || !isTauri}>
              从台账补齐
            </Button>
            <Button size="small" leadingIcon={RiFileExcel2Line} onClick={doImport} disabled={busy || !isTauri}>
              导入工作簿
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {/* 概览 */}
        <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-separator-border bg-separator-border md:grid-cols-4">
          <Stat label="物料总数" value={count(stats?.items ?? 0)} sub={`在用的 ${count(stats?.itemsActive ?? 0)}`} />
          <Stat label="供应商" value={count(stats?.suppliers ?? 0)} sub="含台账里出现过的" />
          <Stat
            label="物料类别"
            // 只数真实类别，把「未分类」单独写进副标题，避免把空类别也算一类
            value={count((stats?.categories ?? []).filter((c) => c.category !== "未分类").length)}
            sub={
              stats
                ? [
                    ...stats.categories
                      .filter((c) => c.category !== "未分类")
                      .slice(0, 2)
                      .map((c) => `${c.category} ${c.count}`),
                    ...(stats.categories.find((c) => c.category === "未分类")
                      ? [`未分类 ${stats.categories.find((c) => c.category === "未分类")!.count}`]
                      : []),
                  ].join(" · ")
                : "—"
            }
          />
          <Stat
            label="物料类型"
            value={stats?.itemTypes.find((t) => t.category !== "未分类")?.category ?? "—"}
            sub={
              stats
                ? stats.itemTypes.map((t) => `${t.category} ${t.count}`).join(" · ")
                : "—"
            }
          />
        </div>

        <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key))}>
          <TabList aria-label="基础资料分类">
            <Tab id="items">物料（{count(stats?.items ?? 0)}）</Tab>
            <Tab id="drawings">图号（{count(stats?.withDrawing ?? 0)}）</Tab>
            <Tab id="suppliers">供应商（{count(stats?.suppliers ?? 0)}）</Tab>
          </TabList>

          <TabPanel id="items">
            <ItemsPanel categories={stats?.categories.map((c) => c.category) ?? []} onChanged={loadStats} busy={busy} />
          </TabPanel>
          <TabPanel id="drawings">
            <DrawingsPanel onChanged={loadStats} busy={busy} />
          </TabPanel>
          <TabPanel id="suppliers">
            <SuppliersPanel onChanged={loadStats} busy={busy} />
          </TabPanel>
        </Tabs>
      </div>
    </>
  );
}

// ---------- 物料 ----------

function ItemsPanel({
  categories,
  onChanged,
  busy,
}: {
  categories: string[];
  onChanged: () => void;
  busy: boolean;
}) {
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [itemType, setItemType] = useState<string>("all");
  const [onlyActive, setOnlyActive] = useState(true);
  const [rows, setRows] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Item | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword, category, itemType, onlyActive]);

  const load = useCallback(async () => {
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const opts = {
        keyword: keyword.trim() || undefined,
        category: category === "all" ? null : category,
        itemType: itemType === "all" ? null : itemType,
        onlyActive,
        limit: PAGE,
        offset,
      };
      const [list, n] = await Promise.all([listItems(opts), countItems(opts)]);
      if (ticket === seq.current) {
        setRows(list);
        setTotal(n);
      }
    } catch (err) {
      toast("物料读取失败", { description: String(err), status: "error" });
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [keyword, category, itemType, onlyActive, offset]);

  useEffect(() => {
    if (!isTauri) return;
    load();
  }, [load]);

  const doDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteItem(pendingDelete.id);
      toast("物料已删除", { description: pendingDelete.itemCode });
      setPendingDelete(null);
      await load();
      onChanged();
    } catch (err) {
      toast("删除失败", { description: String(err), status: "error" });
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          aria-label="搜索物料编码或名称"
          placeholder="编码 / 名称"
          size="small"
          shape="rounded"
          value={keyword}
          onChange={setKeyword}
          className="w-64"
        />
        <Select
          aria-label="物料类别"
          size="sm"
          selectedKey={category}
          onSelectionChange={(key) => setCategory(String(key))}
          className="w-36"
        >
          <>
            <SelectItem id="all">全部类别</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} id={c}>
                {c}
              </SelectItem>
            ))}
          </>
        </Select>
        <Select
          aria-label="物料类型"
          size="sm"
          selectedKey={itemType}
          onSelectionChange={(key) => setItemType(String(key))}
          className="w-32"
        >
          <>
            <SelectItem id="all">全部类型</SelectItem>
            <SelectItem id="外购件">外购件</SelectItem>
            <SelectItem id="加工件">加工件</SelectItem>
          </>
        </Select>
        <label className="flex items-center gap-2 text-body-2-regular text-text-secondary">
          <Switch size="sm" isSelected={onlyActive} onChange={setOnlyActive} aria-label="只看在用" />
          只看在用
        </label>
        {loading ? <Spinner size="xs" aria-label="加载中" /> : null}
        <Button
          size="small"
          variant="ghost"
          leadingIcon={RiRefreshLine}
          onClick={load}
          className="ms-auto"
          disabled={loading}
        >
          刷新
        </Button>
        <Button size="small" leadingIcon={RiAddLine} onClick={() => setEditing("new")} disabled={!isTauri}>
          新增物料
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[1080px] table-fixed border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="w-[132px] px-3 py-2 text-start font-medium">物料编码</th>
              <th className="px-3 py-2 text-start font-medium">物料名称</th>
              <th className="w-[88px] px-3 py-2 text-start font-medium">类型</th>
              <th className="w-[104px] px-3 py-2 text-start font-medium">类别</th>
              <th className="w-[150px] px-3 py-2 text-start font-medium">图号</th>
              <th className="w-[64px] px-3 py-2 text-start font-medium">单位</th>
              <th className="w-[96px] px-3 py-2 text-end font-medium">参考单价</th>
              <th className="w-[132px] px-3 py-2 text-start font-medium">默认供应商</th>
              <th className="w-[72px] px-3 py-2 text-center font-medium">状态</th>
              <th className="w-[88px] px-3 py-2 text-end font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12">
                  <EmptyState
                    icon={RiSearchLine}
                    title={total === 0 ? "还没有物料资料" : "没有匹配的物料"}
                    description={total === 0 ? "点「导入工作簿」从 Excel 读，或手工新增。" : "换个关键字或类别再试。"}
                  />
                </td>
              </tr>
            ) : (
              rows.map((item) => (
                <tr key={item.id} className="border-b border-separator-border last:border-0 hover:bg-background-secondary-hover">
                  <td className="truncate px-3 py-1.5 font-mono text-[12px] text-text-secondary" title={item.itemCode}>
                    {item.itemCode}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-primary" title={item.itemName}>
                    {item.itemName}
                  </td>
                  <td className="truncate px-3 py-1.5">
                    {item.itemType ? (
                      <span
                        className={
                          item.itemType === "外购件"
                            ? "rounded bg-sky-500/12 px-1.5 py-0.5 text-caption-1-semibold text-sky-400"
                            : "rounded bg-amber-500/12 px-1.5 py-0.5 text-caption-1-semibold text-amber-500"
                        }
                      >
                        {item.itemType}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary">{item.category ?? "—"}</td>
                  <td className="truncate px-3 py-1.5 font-mono text-[12px] text-text-tertiary" title={item.drawingNo ?? ""}>
                    {item.drawingNo ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-text-tertiary">{item.unit ?? "—"}</td>
                  <td className="px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary">
                    {item.priceMicros === null ? "—" : priceText(item.priceMicros)}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary">{item.supplier ?? "—"}</td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={item.active ? "text-caption-1-semibold text-emerald-500" : "text-caption-1-regular text-text-tertiary"}>
                      {item.active ? "在用" : "停用"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-end">
                    <button
                      type="button"
                      aria-label={`编辑 ${item.itemCode}`}
                      onClick={() => setEditing(item)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
                    >
                      <RiPencilLine className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`删除 ${item.itemCode}`}
                      onClick={() => setPendingDelete(item)}
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

      <div className="flex items-center justify-between gap-3">
        <p className="text-body-2-regular text-text-tertiary">
          第 {count(offset + 1)}–{count(Math.min(offset + PAGE, total))} 条，共 {count(total)} 条
        </p>
        <div className="flex items-center gap-2">
          <Button size="small" variant="secondary" onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0 || loading}>
            上一页
          </Button>
          <Button size="small" variant="secondary" onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total || loading}>
            下一页
          </Button>
        </div>
      </div>

      {editing ? (
        <ItemDialog
          item={editing === "new" ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            onChanged();
          }}
        />
      ) : null}

      <AlertDialog
        title="删除物料"
        description={pendingDelete ? `将删除 ${pendingDelete.itemCode} ${pendingDelete.itemName}。台账里的历史行不受影响。` : ""}
        confirmLabel="删除"
        onConfirm={doDelete}
        isOpen={pendingDelete !== null}
        onOpenChange={(open: boolean) => !open && setPendingDelete(null)}
        variant="danger"
      />
      {busy ? <span className="hidden" /> : null}
    </div>
  );
}

function ItemDialog({
  item,
  categories,
  onClose,
  onSaved,
}: {
  item: Item | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<ItemInput>({
    itemCode: item?.itemCode ?? "",
    itemName: item?.itemName ?? "",
    category: item?.category ?? "",
    unit: item?.unit ?? "",
    priceMicros: item?.priceMicros ?? null,
    supplier: item?.supplier ?? "",
    remark: item?.remark ?? "",
    active: item?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  // 类别候选：只留真实类别（排除空值与历史污染），去重排序
  const categoryOptions = useMemo(
    () => Array.from(new Set(categories.filter((c) => c && c.trim() !== "旧版基础信息"))).sort(),
    [categories],
  );
  const set = <K extends keyof ItemInput>(key: K, value: ItemInput[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      if (item) await updateItem(item.id, form);
      else await createItem(form);
      toast(item ? "物料已更新" : "物料已新增", { description: form.itemCode, status: "success" });
      await onSaved();
    } catch (err) {
      toast("保存失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onOpenChange={(open: boolean) => !open && onClose()} size="md">
      {({ close }) => (
        <>
          <ModalHeader title={item ? "编辑物料" : "新增物料"} description="编码与名称必填" />
          <ModalBody className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="物料编码">
                <Input
                  size="small"
                  value={form.itemCode}
                  onChange={(v) => set("itemCode", v)}
                  isDisabled={Boolean(item)}
                />
              </Labeled>
              <Labeled label="单位">
                <Input size="small" value={form.unit ?? ""} onChange={(v) => set("unit", v)} />
              </Labeled>
            </div>
            <Labeled label="物料名称">
              <Input size="small" value={form.itemName} onChange={(v) => set("itemName", v)} />
            </Labeled>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="图号">
                <Input
                  size="small"
                  placeholder="加工件的图纸号，如 QLKJ480-002.065"
                  value={form.drawingNo ?? ""}
                  onChange={(v) => set("drawingNo", v)}
                />
              </Labeled>
              <Labeled label="类型">
                <Select
                  aria-label="物料类型"
                  size="sm"
                  selectedKey={form.itemType || "none"}
                  onSelectionChange={(key) => set("itemType", key === "none" ? "" : String(key))}
                  className="w-full"
                >
                  <>
                    <SelectItem id="none">未分类</SelectItem>
                    <SelectItem id="外购件">外购件</SelectItem>
                    <SelectItem id="加工件">加工件</SelectItem>
                  </>
                </Select>
              </Labeled>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="类别">
                <ComboPicker
                  ariaLabel="物料类别"
                  value={form.category ?? ""}
                  onChange={(v) => set("category", v)}
                  options={categoryOptions.map((c) => ({ value: c }))}
                  placeholder="选或输入新类别"
                />
              </Labeled>
              <Labeled label="参考单价（元）">
                <Input
                  size="small"
                  value={form.priceMicros == null ? "" : (form.priceMicros / 10000).toFixed(4)}
                  onChange={(v) => {
                    const n = Number(v.replace(/[,，\s]/g, ""));
                    set("priceMicros", v.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 10000));
                  }}
                />
              </Labeled>
            </div>
            <Labeled label="默认供应商">
              <Input size="small" value={form.supplier ?? ""} onChange={(v) => set("supplier", v)} />
            </Labeled>
            <Labeled label="备注">
              <Input size="small" value={form.remark ?? ""} onChange={(v) => set("remark", v)} />
            </Labeled>
            <label className="flex items-center gap-2 text-body-2-regular text-text-secondary">
              <Switch size="sm" isSelected={form.active ?? true} onChange={(v) => set("active", v)} aria-label="在用" />
              在用（停用后不出现在开单下拉里）
            </label>
          </ModalBody>
          <ModalFooter>
            <Button size="small" variant="secondary" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button size="small" onClick={save} disabled={busy || !form.itemCode.trim() || !form.itemName.trim()}>
              {busy ? "保存中" : "保存"}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

// ---------- 供应商 ----------

/**
 * 图号页：按图号查物料，也能给缺图号的物料补录。
 *
 * 图号存在 items.drawing_no 上，这里不做独立表——避免图号和物料两处存两份。
 * 默认只看「有图号」的，切到「缺图号」就是待补清单（主要是加工件）。
 */
function DrawingsPanel({ onChanged, busy }: { onChanged: () => void; busy: boolean }) {
  const [keyword, setKeyword] = useState("");
  const [mode, setMode] = useState<"has" | "missing">("has");
  const [rows, setRows] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    setOffset(0);
  }, [keyword, mode]);

  const load = useCallback(async () => {
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const opts = {
        keyword: keyword.trim() || undefined,
        onlyActive: true,
        withDrawing: mode === "has",
        limit: PAGE,
        offset,
      };
      const [list, n] = await Promise.all([listItems(opts), countItems(opts)]);
      if (ticket === seq.current) {
        setRows(list);
        setTotal(n);
      }
    } catch (err) {
      toast("图号读取失败", { description: String(err), status: "error" });
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [keyword, mode, offset]);

  useEffect(() => {
    if (!isTauri) return;
    load();
  }, [load]);

  const filled = mode === "has";

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          aria-label="搜索图号或物料"
          placeholder="图号 / 物料编码 / 名称"
          size="small"
          shape="rounded"
          value={keyword}
          onChange={setKeyword}
          className="w-72"
        />
        <SegmentedControl
          aria-label="图号范围"
          selectedKeys={[mode]}
          onSelectionChange={(keys) => {
            const next = Array.from(keys)[0];
            if (next) setMode(String(next) === "missing" ? "missing" : "has");
          }}
        >
          <SegmentedControlItem id="has">有图号</SegmentedControlItem>
          <SegmentedControlItem id="missing">缺图号</SegmentedControlItem>
        </SegmentedControl>
        {loading ? <Spinner size="xs" aria-label="加载中" /> : null}
        <span className="text-body-2-regular text-text-tertiary">
          共 {count(total)} 条
          {filled ? "（按图号或物料搜）" : "（加工件应有图号，这里列出待补的）"}
        </span>
        <Button size="small" variant="ghost" leadingIcon={RiRefreshLine} onClick={load} className="ms-auto" disabled={loading}>
          刷新
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[860px] table-fixed border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="w-[210px] px-3 py-2 text-start font-medium">图号</th>
              <th className="w-[132px] px-3 py-2 text-start font-medium">物料编码</th>
              <th className="px-3 py-2 text-start font-medium">物料名称</th>
              <th className="w-[88px] px-3 py-2 text-start font-medium">类型</th>
              <th className="w-[104px] px-3 py-2 text-start font-medium">类别</th>
              <th className="w-[64px] px-3 py-2 text-start font-medium">单位</th>
              <th className="w-[72px] px-3 py-2 text-end font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12">
                  <EmptyState
                    icon={RiSearchLine}
                    title={filled ? "没有带图号的物料" : "没有缺图号的加工件"}
                    description={
                      filled
                        ? "图号来自工作簿「基础信息」表的加工件，或在这里手工补录。"
                        : "所有加工件都已有图号。"
                    }
                  />
                </td>
              </tr>
            ) : (
              rows.map((item) => (
                <tr key={item.id} className="border-b border-separator-border last:border-0 hover:bg-background-secondary-hover">
                  <td className="truncate px-3 py-1.5 font-mono text-[12px] text-text-secondary" title={item.drawingNo ?? ""}>
                    {item.drawingNo ?? <span className="text-text-tertiary">（未填）</span>}
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-[12px] text-text-tertiary" title={item.itemCode}>
                    {item.itemCode}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-primary" title={item.itemName}>
                    {item.itemName}
                  </td>
                  <td className="truncate px-3 py-1.5">
                    {item.itemType ? (
                      <span
                        className={
                          item.itemType === "外购件"
                            ? "rounded bg-sky-500/12 px-1.5 py-0.5 text-caption-1-semibold text-sky-400"
                            : "rounded bg-amber-500/12 px-1.5 py-0.5 text-caption-1-semibold text-amber-500"
                        }
                      >
                        {item.itemType}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary">{item.category ?? "—"}</td>
                  <td className="px-3 py-1.5 text-text-tertiary">{item.unit ?? "—"}</td>
                  <td className="px-3 py-1.5 text-end">
                    <button
                      type="button"
                      aria-label={`${item.drawingNo ? "改看" : "补"}"图号 ${item.itemCode}`}
                      onClick={() => setEditing(item)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
                    >
                      <RiPencilLine className="size-3.5" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-body-2-regular text-text-tertiary">
          第 {count(offset + 1)}–{count(Math.min(offset + PAGE, total))} 条，共 {count(total)} 条
        </p>
        <div className="flex items-center gap-2">
          <Button size="small" variant="secondary" onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0 || loading}>
            上一页
          </Button>
          <Button size="small" variant="secondary" onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total || loading}>
            下一页
          </Button>
        </div>
      </div>

      {editing ? (
        <DrawingDialog
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            onChanged();
          }}
        />
      ) : null}
      {busy ? <span className="hidden" /> : null}
    </div>
  );
}

/** 只改图号的小弹窗：不把整条物料的表单再搬一遍。 */
function DrawingDialog({
  item,
  onClose,
  onSaved,
}: {
  item: Item;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [drawingNo, setDrawingNo] = useState(item.drawingNo ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateItem(item.id, {
        itemCode: item.itemCode,
        itemName: item.itemName,
        category: item.category,
        unit: item.unit,
        priceMicros: item.priceMicros,
        itemType: item.itemType,
        drawingNo: drawingNo.trim() || null,
        supplier: item.supplier,
        remark: item.remark,
        active: item.active,
      });
      toast("图号已保存", { description: `${item.itemName} → ${drawingNo.trim() || "（清空）"}`, status: "success" });
      await onSaved();
    } catch (err) {
      toast("保存失败", { description: String(err), status: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onOpenChange={(open: boolean) => !open && onClose()} size="sm">
      {({ close }) => (
        <>
          <ModalHeader title="图号" description={`${item.itemCode} · ${item.itemName}`} />
          <ModalBody className="flex flex-col gap-3">
            <Labeled label="图号">
              <Input
                size="small"
                autoFocus
                placeholder="如 QLKJ480-002.065"
                value={drawingNo}
                onChange={setDrawingNo}
              />
            </Labeled>
          </ModalBody>
          <ModalFooter>
            <Button size="small" variant="secondary" onClick={close} disabled={saving}>
              取消
            </Button>
            <Button size="small" onClick={save} disabled={saving}>
              {saving ? "保存中" : "保存"}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

function SuppliersPanel({ onChanged, busy }: { onChanged: () => void; busy: boolean }) {
  const [keyword, setKeyword] = useState("");
  const [rows, setRows] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Supplier | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listSuppliers(keyword.trim() || undefined));
    } catch (err) {
      toast("供应商读取失败", { description: String(err), status: "error" });
    } finally {
      setLoading(false);
    }
  }, [keyword]);

  useEffect(() => {
    if (!isTauri) return;
    load();
  }, [load]);

  const doDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteSupplier(pendingDelete.id);
      toast("供应商已删除", { description: pendingDelete.name });
      setPendingDelete(null);
      await load();
      onChanged();
    } catch (err) {
      toast("删除失败", { description: String(err), status: "error" });
    }
  };

  const used = useMemo(() => rows.filter((r) => r.hits > 0).length, [rows]);

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          aria-label="搜索供应商"
          placeholder="供应商名称"
          size="small"
          shape="rounded"
          value={keyword}
          onChange={setKeyword}
          className="w-64"
        />
        <span className="text-body-2-regular text-text-tertiary">
          共 {count(rows.length)} 家，其中 {count(used)} 家在台账里有记录
        </span>
        {loading ? <Spinner size="xs" aria-label="加载中" /> : null}
        <Button size="small" leadingIcon={RiAddLine} onClick={() => setEditing("new")} className="ms-auto" disabled={!isTauri}>
          新增供应商
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[720px] table-fixed border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="px-3 py-2 text-start font-medium">供应商名称</th>
              <th className="w-[120px] px-3 py-2 text-start font-medium">联系人</th>
              <th className="w-[140px] px-3 py-2 text-start font-medium">电话</th>
              <th className="w-[96px] px-3 py-2 text-end font-medium">台账行数</th>
              <th className="w-[72px] px-3 py-2 text-center font-medium">状态</th>
              <th className="w-[88px] px-3 py-2 text-end font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12">
                  <EmptyState icon={RiSearchLine} title="没有供应商" description="点「导入工作簿」从供应商名称表读，或手工新增。" />
                </td>
              </tr>
            ) : (
              rows.map((supplier) => (
                <tr key={supplier.id} className="border-b border-separator-border last:border-0 hover:bg-background-secondary-hover">
                  <td className="truncate px-3 py-1.5 text-text-primary">{supplier.name}</td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary">{supplier.contact ?? "—"}</td>
                  <td className="truncate px-3 py-1.5 font-mono text-[12px] text-text-tertiary">{supplier.phone ?? "—"}</td>
                  <td className="px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary">{count(supplier.hits)}</td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={supplier.active ? "text-caption-1-semibold text-emerald-500" : "text-caption-1-regular text-text-tertiary"}>
                      {supplier.active ? "在用" : "停用"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-end">
                    <button
                      type="button"
                      aria-label={`编辑 ${supplier.name}`}
                      onClick={() => setEditing(supplier)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
                    >
                      <RiPencilLine className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`删除 ${supplier.name}`}
                      onClick={() => setPendingDelete(supplier)}
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
        <SupplierDialog
          supplier={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            onChanged();
          }}
        />
      ) : null}

      <AlertDialog
        title="删除供应商"
        description={pendingDelete ? `将删除「${pendingDelete.name}」。台账里已记的供应商名称不受影响。` : ""}
        confirmLabel="删除"
        onConfirm={doDelete}
        isOpen={pendingDelete !== null}
        onOpenChange={(open: boolean) => !open && setPendingDelete(null)}
        variant="danger"
      />
      {busy ? <span className="hidden" /> : null}
    </div>
  );
}

function SupplierDialog({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<SupplierInput>({
    name: supplier?.name ?? "",
    contact: supplier?.contact ?? "",
    phone: supplier?.phone ?? "",
    remark: supplier?.remark ?? "",
    active: supplier?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SupplierInput>(key: K, value: SupplierInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      if (supplier) await updateSupplier(supplier.id, form);
      else await createSupplier(form);
      toast(supplier ? "供应商已更新" : "供应商已新增", { description: form.name, status: "success" });
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
          <ModalHeader title={supplier ? "编辑供应商" : "新增供应商"} />
          <ModalBody className="flex flex-col gap-3">
            <Labeled label="名称">
              <Input size="small" value={form.name} onChange={(v) => set("name", v)} />
            </Labeled>
            <Labeled label="联系人">
              <Input size="small" value={form.contact ?? ""} onChange={(v) => set("contact", v)} />
            </Labeled>
            <Labeled label="电话">
              <Input size="small" value={form.phone ?? ""} onChange={(v) => set("phone", v)} />
            </Labeled>
            <Labeled label="备注">
              <Input size="small" value={form.remark ?? ""} onChange={(v) => set("remark", v)} />
            </Labeled>
            <label className="flex items-center gap-2 text-body-2-regular text-text-secondary">
              <Switch size="sm" isSelected={form.active ?? true} onChange={(v) => set("active", v)} aria-label="在用" />
              在用
            </label>
          </ModalBody>
          <ModalFooter>
            <Button size="small" variant="secondary" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button size="small" onClick={save} disabled={busy || !form.name.trim()}>
              {busy ? "保存中" : "保存"}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-background-primary-default px-4 py-3">
      <p className="text-caption-1-semibold text-text-tertiary">{label}</p>
      <p className="mt-1 font-mono text-title-3-semibold tabular-nums text-text-primary">{value}</p>
      {sub ? <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">{sub}</p> : null}
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
