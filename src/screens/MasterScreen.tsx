import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiCheckLine,
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
  exportItems,
  exportSuppliers,
  importMasterWorkbook,
  isTauri,
  listDict,
  listItems,
  listSuppliers,
  lookupItem,
  masterStats,
  updateItem,
  updateSupplier,
} from "../lib/api";
import type { Item, ItemInput, MasterStats, Supplier, SupplierInput } from "../lib/types";
import { exportFileName, saveCsvFile } from "../lib/exportCsv";
import { count, parsePriceToMicros, priceInput4, priceText } from "../lib/format";
import { onItemSortChange, saveItemSort, storedItemSort, type ItemSort } from "../lib/itemSortPrefs";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { SearchField } from "@/components/base/search-field/search-field";
import { Pagination } from "@/components/base/pagination/pagination";
import { Select, SelectItem } from "@/components/base/select/select";
import { Switch } from "@/components/base/switch/switch";
import { SegmentedControl, SegmentedControlItem } from "@/components/base/segmented-control/segmented-control";
import { Tabs, Tab, TabList, TabPanel } from "@/components/base/tabs/tabs";
import { AlertDialog, Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";
import { Spinner } from "@/components/base/spinner/spinner";
import { EmptyState } from "../components/EmptyState";
import { DictPanel } from "../components/DictPanel";
import { ItemCatalog } from "../components/ItemCatalog";
import { PageHeader } from "../components/AppShell";

const PAGE_SIZES = [50, 100, 200, 500] as const;
const PAGE_SIZE_KEY = "master.pageSize";

function storedPageSize(): number {
  try {
    const n = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
    if (PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number])) return n;
  } catch {
    // 存不下就用默认
  }
  return 100;
}

/** 记住本机的每页条数；存不下也不影响本次使用。 */
function savePageSize(size: number): void {
  try {
    window.localStorage.setItem(PAGE_SIZE_KEY, String(size));
  } catch {
    // 隐私模式或存储被禁：下次退回默认
  }
}

/** 基础资料：物料主数据 + 供应商 + 字典（单位/类别/类型/出库部门/采购人）。 */
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
        description="物料与供应商是全库通用的基础资料，各仓库共用；选物料带出单位与参考单价，供应商从下拉里挑"
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

      {/* 整页不滚：概览、标签栏固定，表格自己占满剩余高度并在内部滚动（和台账一致） */}
      <div className="flex min-h-0 flex-1 flex-col px-6 pt-5 pb-4">
        {/* 概览 */}
        <div className="mb-4 grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-xl border border-separator-border bg-separator-border md:grid-cols-4">
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

        <Tabs
          selectedKey={tab}
          onSelectionChange={(key) => setTab(String(key))}
          className="min-h-0 flex-1"
        >
          <TabList aria-label="基础资料分类">
            <Tab id="items">物料（{count(stats?.items ?? 0)}）</Tab>
            <Tab id="drawings">图号（{count(stats?.withDrawing ?? 0)}）</Tab>
            <Tab id="suppliers">供应商（{count(stats?.suppliers ?? 0)}）</Tab>
            <Tab id="dict">字典</Tab>
          </TabList>

          <TabPanel id="items" className="flex min-h-0 flex-1 flex-col">
            <ItemsPanel
              categories={stats?.categories.map((c) => c.category) ?? []}
              itemTypes={stats?.itemTypes.map((t) => t.category) ?? []}
              onChanged={loadStats}
              busy={busy}
            />
          </TabPanel>
          <TabPanel id="drawings" className="flex min-h-0 flex-1 flex-col">
            <DrawingsPanel onChanged={loadStats} busy={busy} />
          </TabPanel>
          <TabPanel id="suppliers" className="flex min-h-0 flex-1 flex-col">
            <SuppliersPanel onChanged={loadStats} busy={busy} />
          </TabPanel>
          <TabPanel id="dict" className="flex min-h-0 flex-1 flex-col">
            <DictPanel onChanged={loadStats} />
          </TabPanel>
        </Tabs>
      </div>
    </>
  );
}

// ---------- 物料 ----------

function ItemsPanel({
  categories,
  itemTypes,
  onChanged,
  busy,
}: {
  categories: string[];
  itemTypes: string[];
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
  // 列表排序：跟输入关键字一样，改了要回到第一页
  const [sortOrder, setSortOrder] = useState<ItemSort>(() => storedItemSort());
  const [pageSize, setPageSize] = useState<number>(() => storedPageSize());
  // 分页信息：总页数至少为 1，避免 0 条时显示「第 1 / 0 页」
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageIndex = Math.min(pageCount, Math.floor(offset / pageSize) + 1);
  // 表格滚动容器：翻页后要滚回顶部
  const tableRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    saveItemSort(sortOrder);
  }, [sortOrder]);
  useEffect(() => onItemSortChange(setSortOrder), []);

  const filterTypes = useMemo(
    () =>
      Array.from(
        new Set(["外购件", "加工件", ...itemTypes.filter((t) => t && t.trim() !== "" && t.trim() !== "未分类")]),
      ),
    [itemTypes],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword, category, itemType, onlyActive, sortOrder, pageSize]);

  const load = useCallback(async () => {
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const opts = {
        keyword: keyword.trim() || undefined,
        category: category === "all" ? null : category,
        itemType: itemType === "all" ? null : itemType,
        onlyActive,
        limit: pageSize,
        offset,
      };
      const [list, n] = await Promise.all([
        listItems({ ...opts, order: sortOrder }),
        countItems(opts),
      ]);
      if (ticket === seq.current) {
        setRows(list);
        setTotal(n);
      }
    } catch (err) {
      toast("物料读取失败", { description: String(err), status: "error" });
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [keyword, category, itemType, onlyActive, offset, sortOrder, pageSize]);

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

  // 导出走当前筛选（关键字/类别/类型/在用/排序），不分页：文件里是全部命中行
  const doExport = () =>
    saveCsvFile("导出物料资料", exportFileName("物料资料"), (path) =>
      exportItems(
        {
          keyword: keyword.trim() || undefined,
          category: category === "all" ? null : category,
          itemType: itemType === "all" ? null : itemType,
          onlyActive,
          order: sortOrder,
        },
        path,
      ),
    );

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <SearchField
          aria-label="搜索物料编码、名称、库位或规格"
          placeholder="编码 / 名称 / 库位 / 规格"
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
            {filterTypes.map((t) => (
              <SelectItem key={t} id={t}>
                {t}
              </SelectItem>
            ))}
          </>
        </Select>
        <label className="flex items-center gap-2 text-body-2-regular text-text-secondary">
          <Switch size="sm" isSelected={onlyActive} onChange={setOnlyActive} aria-label="只看在用" />
          只看在用
        </label>
        <Select
          aria-label="排序方式"
          size="sm"
          selectedKey={sortOrder}
          onSelectionChange={(key) => setSortOrder(String(key) as ItemSort)}
          className="w-36"
        >
          <>
            <SelectItem id="code">按编码 ↑</SelectItem>
            <SelectItem id="code_desc">按编码 ↓</SelectItem>
            <SelectItem id="name">按名称</SelectItem>
            <SelectItem id="newest">最新建档在前</SelectItem>
            <SelectItem id="oldest">最早建档在前</SelectItem>
          </>
        </Select>
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
        <Button
          size="small"
          variant="secondary"
          leadingIcon={RiDownload2Line}
          onClick={doExport}
          disabled={!isTauri}
          title="按当前筛选条件导出全部物料（不只是本页）"
        >
          导出 CSV
        </Button>
        <Button size="small" leadingIcon={RiAddLine} onClick={() => setEditing("new")} disabled={!isTauri}>
          新增物料
        </Button>
      </div>

      <div ref={tableRef} className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[1360px] table-fixed border-collapse text-[0.8125rem]">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="w-[148px] px-3 py-2 text-start font-medium whitespace-nowrap">物料编码</th>
              <th className="w-[240px] px-3 py-2 text-start font-medium whitespace-nowrap">物料名称</th>
              <th className="w-[104px] px-3 py-2 text-start font-medium whitespace-nowrap">库位</th>
              <th className="w-[136px] px-3 py-2 text-start font-medium whitespace-nowrap">规格型号</th>
              <th className="w-[76px] px-3 py-2 text-start font-medium whitespace-nowrap">单位</th>
              <th className="w-[100px] px-3 py-2 text-start font-medium whitespace-nowrap">类型</th>
              <th className="w-[110px] px-3 py-2 text-start font-medium whitespace-nowrap">类别</th>
              <th className="w-[144px] px-3 py-2 text-start font-medium whitespace-nowrap">图号</th>
              <th className="w-[108px] px-3 py-2 text-end font-medium whitespace-nowrap font-mono tabular-nums">参考单价</th>
              <th className="w-[168px] px-3 py-2 text-start font-medium whitespace-nowrap">默认供应商</th>
              <th className="w-[76px] px-3 py-2 text-center font-medium whitespace-nowrap">状态</th>
              <th className="w-[84px] px-3 py-2 text-end font-medium whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-4 py-12">
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
                  <td className="truncate px-3 py-1.5 font-mono text-[0.75rem] text-text-secondary whitespace-nowrap" title={item.itemCode}>
                    {item.itemCode}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-primary" title={item.itemName}>
                    {item.itemName}
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-[0.75rem] text-text-tertiary" title={item.location ?? ""}>
                    {item.location ?? "—"}
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-[0.75rem] text-text-tertiary" title={item.spec ?? ""}>
                    {item.spec ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-text-tertiary whitespace-nowrap">{item.unit ?? "—"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {item.itemType ? (
                      <span
                        className={
                          item.itemType === "外购件"
                            ? "inline-block whitespace-nowrap rounded bg-sky-500/12 px-2 py-0.5 text-caption-1-semibold text-sky-400"
                            : "inline-block whitespace-nowrap rounded bg-amber-500/12 px-2 py-0.5 text-caption-1-semibold text-amber-500"
                        }
                      >
                        {item.itemType}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary" title={item.category ?? ""}>{item.category ?? "—"}</td>
                  <td className="truncate px-3 py-1.5 font-mono text-[0.75rem] text-text-tertiary" title={item.drawingNo ?? ""}>
                    {item.drawingNo ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary whitespace-nowrap">
                    {item.priceMicros === null ? "—" : priceText(item.priceMicros)}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary" title={item.supplier ?? ""}>{item.supplier ?? "—"}</td>
                  <td className="px-3 py-1.5 text-center whitespace-nowrap">
                    <span className={item.active ? "text-caption-1-semibold text-emerald-500" : "text-caption-1-regular text-text-tertiary"}>
                      {item.active ? "在用" : "停用"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-end whitespace-nowrap">
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

      <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
        <p className="text-body-2-regular text-text-tertiary">
          第 {count(offset + 1)}–{count(Math.min(offset + pageSize, total))} 条，共 {count(total)} 条
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
            每页
            <select
              aria-label="每页条数"
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value);
                setPageSize(next);
                try {
                  window.localStorage.setItem(PAGE_SIZE_KEY, String(next));
                } catch {
                  // 忽略
                }
                setOffset(0);
                tableRef.current?.scrollTo({ top: 0 });
              }}
              className="h-7 rounded-md border border-border-button-default bg-background-secondary-default px-1.5 font-mono text-caption-1-regular tabular-nums text-text-secondary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            条
          </label>
          <Pagination
            page={pageIndex}
            totalPages={pageCount}
            onChange={(next) => {
              setOffset(Math.max(0, (next - 1) * pageSize));
              tableRef.current?.scrollTo({ top: 0 });
            }}
            previousLabel="上一页"
            nextLabel="下一页"
            aria-label="物料分页"
          />
        </div>
      </div>

      {editing ? (
        <ItemDialog
          item={editing === "new" ? null : editing}
          categories={categories}
          itemTypes={itemTypes}
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
  itemTypes,
  onClose,
  onSaved,
}: {
  item: Item | null;
  categories: string[];
  itemTypes: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<ItemInput>({
    itemCode: item?.itemCode ?? "",
    itemName: item?.itemName ?? "",
    category: item?.category ?? "",
    unit: item?.unit ?? "",
    priceMicros: item?.priceMicros ?? null,
    // 这几个字段原来没进初值，编辑保存时会被当成「清空」写回去，
    // 导入带进来的规格/类型/图号/库位一改物料就丢了。
    spec: item?.spec ?? "",
    itemType: item?.itemType === "未分类" ? "" : (item?.itemType ?? ""),
    drawingNo: item?.drawingNo ?? "",
    location: item?.location ?? "",
    owner: item?.owner ?? "",
    supplier: item?.supplier ?? "",
    remark: item?.remark ?? "",
    active: item?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  // 新增时编码撞上已有物料：右栏提示换个编码，别等保存被后端拒了才发现
  const [duplicateCode, setDuplicateCode] = useState(false);
  // 单位与类型从字典取候选；类别合并字典与 stats 里的实际分布（含未进字典的旧值）
  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [typeOptions, setTypeOptions] = useState<string[]>([]);
  const [dictCategories, setDictCategories] = useState<string[]>([]);

  // 编辑已有物料时不用查重（编码框本身是锁住的）
  useEffect(() => {
    if (!isTauri || item !== null) {
      setDuplicateCode(false);
      return;
    }
    const code = form.itemCode.trim();
    if (!code) {
      setDuplicateCode(false);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      lookupItem(code)
        .then((hit) => {
          if (alive) setDuplicateCode(hit !== null);
        })
        .catch(() => {
          if (alive) setDuplicateCode(false);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [form.itemCode, item]);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    void (async () => {
      try {
        const [units, types, cats] = await Promise.all([
          listDict("unit", undefined, true),
          listDict("item_type", undefined, true),
          listDict("category", undefined, true),
        ]);
        if (!alive) return;
        setUnitOptions(units.map((entry) => entry.value));
        setTypeOptions(types.map((entry) => entry.value));
        setDictCategories(cats.map((entry) => entry.value));
      } catch {
        // 读不到字典就只剩手输，不挡保存
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 类别候选：只留真实类别（排除空值与历史污染），去重排序
  const categoryOptions = useMemo(
    () =>
      Array.from(
        new Set([...dictCategories, ...categories].filter((c) => c && c.trim() !== "" && c.trim() !== "旧版基础信息")),
      ).sort(),
    [dictCategories, categories],
  );
  // 类型候选：合并常用类型、字典类型与已有物料类型
  const mergedTypeOptions = useMemo(
    () =>
      Array.from(
        new Set([
          "外购件",
          "加工件",
          ...typeOptions,
          ...itemTypes.filter((t) => t && t.trim() !== "" && t.trim() !== "未分类"),
        ]),
      ),
    [typeOptions, itemTypes],
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
    <Modal
      isOpen
      onOpenChange={(open: boolean) => !open && onClose()}
      size="xl"
      className="max-h-[88vh] w-[880px] max-w-[92vw] overflow-y-auto"
    >
      {({ close }) => (
        <>
          <ModalHeader title={item ? "编辑物料" : "新增物料"} description="编码与名称必填" />
          <ModalBody className="grid grid-cols-[minmax(0,1fr)_19rem] items-start gap-4">
            <div className="flex min-w-0 flex-col gap-3">
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
                <CategoryDropdown
                  label="单位"
                  placeholder="选或输入新单位"
                  value={form.unit ?? ""}
                  options={unitOptions}
                  onChange={(v) => set("unit", v)}
                />
              </Labeled>
            </div>
            <Labeled label="物料名称">
              <Input size="small" value={form.itemName} onChange={(v) => set("itemName", v)} />
            </Labeled>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="库位">
                <Input
                  size="small"
                  placeholder="如 D-01-02-4F"
                  value={form.location ?? ""}
                  onChange={(v) => set("location", v)}
                />
              </Labeled>
              <Labeled label="规格型号">
                <Input
                  size="small"
                  placeholder="如 5*5、M8X50"
                  value={form.spec ?? ""}
                  onChange={(v) => set("spec", v)}
                />
              </Labeled>
            </div>
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
                <CategoryDropdown
                  label="类型"
                  placeholder="选或输入新类型"
                  value={form.itemType ?? ""}
                  options={mergedTypeOptions}
                  onChange={(v) => set("itemType", v)}
                />
              </Labeled>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="类别">
                <CategoryDropdown
                  label="类别"
                  placeholder="选或输入新类别"
                  value={form.category ?? ""}
                  options={categoryOptions}
                  onChange={(v) => set("category", v)}
                />
              </Labeled>
              <Labeled label="参考单价（元）">
                <PriceInput
                  value={form.priceMicros ?? null}
                  onChange={(micros) => set("priceMicros", micros)}
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
            </div>

            {/* 右栏：现有物料只读对照，照着已有写法录入，也避免建重 */}
            <ItemCatalog
              keyword={form.itemCode.trim() || form.itemName.trim()}
              hint={
                item === null && form.itemCode.trim() && duplicateCode
                  ? `编码 ${form.itemCode.trim()} 已存在，换个编码或直接编辑那一条`
                  : null
              }
            />
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
  const [pageSize, setPageSize] = useState<number>(() => storedPageSize());
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageIndex = Math.min(pageCount, Math.floor(offset / pageSize) + 1);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOffset(0);
  }, [keyword, mode, pageSize]);

  const load = useCallback(async () => {
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const opts = {
        keyword: keyword.trim() || undefined,
        onlyActive: true,
        withDrawing: mode === "has",
        limit: pageSize,
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
  }, [keyword, mode, offset, pageSize]);

  useEffect(() => {
    if (!isTauri) return;
    load();
  }, [load]);

  const filled = mode === "has";

  // 图号页导出：沿用「有图号 / 缺图号」的取舍，导出的就是屏幕上这批（不分页）
  const doExport = () =>
    saveCsvFile(`导出${filled ? "图号" : "缺图号"}清单`, exportFileName(filled ? "物料图号" : "缺图号物料"), (path) =>
      exportItems(
        {
          keyword: keyword.trim() || undefined,
          onlyActive: true,
          withDrawing: filled,
        },
        path,
      ),
    );

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
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
        <Button
          size="small"
          variant="secondary"
          leadingIcon={RiDownload2Line}
          onClick={doExport}
          disabled={!isTauri || total === 0}
          title="导出当前清单的全部行（不只是本页）"
        >
          导出 CSV
        </Button>
      </div>

      <div ref={tableRef} className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[960px] table-fixed border-collapse text-[0.8125rem]">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="w-[180px] px-3 py-2 text-start font-medium whitespace-nowrap">图号</th>
              <th className="w-[148px] px-3 py-2 text-start font-medium whitespace-nowrap">物料编码</th>
              <th className="w-[240px] px-3 py-2 text-start font-medium whitespace-nowrap">物料名称</th>
              <th className="w-[100px] px-3 py-2 text-start font-medium whitespace-nowrap">类型</th>
              <th className="w-[110px] px-3 py-2 text-start font-medium whitespace-nowrap">类别</th>
              <th className="w-[76px] px-3 py-2 text-start font-medium whitespace-nowrap">单位</th>
              <th className="w-[80px] px-3 py-2 text-end font-medium whitespace-nowrap">操作</th>
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
                  <td className="truncate px-3 py-1.5 font-mono text-[0.75rem] text-text-secondary whitespace-nowrap" title={item.drawingNo ?? ""}>
                    {item.drawingNo ?? <span className="text-text-tertiary">（未填）</span>}
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-[0.75rem] text-text-tertiary whitespace-nowrap" title={item.itemCode}>
                    {item.itemCode}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-primary" title={item.itemName}>
                    {item.itemName}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {item.itemType ? (
                      <span
                        className={
                          item.itemType === "外购件"
                            ? "inline-block whitespace-nowrap rounded bg-sky-500/12 px-2 py-0.5 text-caption-1-semibold text-sky-400"
                            : "inline-block whitespace-nowrap rounded bg-amber-500/12 px-2 py-0.5 text-caption-1-semibold text-amber-500"
                        }
                      >
                        {item.itemType}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary" title={item.category ?? ""}>{item.category ?? "—"}</td>
                  <td className="px-3 py-1.5 text-text-tertiary whitespace-nowrap">{item.unit ?? "—"}</td>
                  <td className="px-3 py-1.5 text-end whitespace-nowrap">
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

      <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
        <p className="text-body-2-regular text-text-tertiary">
          第 {count(offset + 1)}–{count(Math.min(offset + pageSize, total))} 条，共 {count(total)} 条
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
            每页
            <select
              aria-label="每页条数"
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value);
                setPageSize(next);
                setOffset(0);
                savePageSize(next);
                tableRef.current?.scrollTo({ top: 0 });
              }}
              className="h-7 rounded-md border border-border-button-default bg-background-secondary-default px-1.5 font-mono text-caption-1-regular tabular-nums text-text-secondary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            条
          </label>
          <Pagination
            page={pageIndex}
            totalPages={pageCount}
            onChange={(next) => {
              setOffset(Math.max(0, (next - 1) * pageSize));
              tableRef.current?.scrollTo({ top: 0 });
            }}
            previousLabel="上一页"
            nextLabel="下一页"
            aria-label="图号分页"
          />
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
        spec: item.spec,
        itemType: item.itemType,
        drawingNo: drawingNo.trim() || null,
        location: item.location,
        owner: item.owner,
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => storedPageSize());
  const tableRef = useRef<HTMLDivElement>(null);

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const displayRows = useMemo(
    () => rows.slice((page - 1) * pageSize, page * pageSize),
    [rows, page, pageSize],
  );

  useEffect(() => {
    setPage(1);
  }, [keyword, pageSize]);

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

  // 导出当前关键字命中的全部供应商（列表是前端分页，文件里给全量）
  const doExport = () =>
    saveCsvFile("导出供应商", exportFileName("供应商"), (path) =>
      exportSuppliers(keyword.trim() || undefined, path),
    );

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
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
        <Button
          size="small"
          variant="secondary"
          leadingIcon={RiDownload2Line}
          onClick={doExport}
          className="ms-auto"
          disabled={!isTauri || rows.length === 0}
          title="按当前搜索导出全部供应商"
        >
          导出 CSV
        </Button>
        <Button size="small" leadingIcon={RiAddLine} onClick={() => setEditing("new")} disabled={!isTauri}>
          新增供应商
        </Button>
      </div>

      <div ref={tableRef} className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-button-default bg-background-primary-default">
        <table className="w-full min-w-[800px] table-fixed border-collapse text-[0.8125rem]">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
              <th className="px-3 py-2 text-start font-medium whitespace-nowrap">供应商名称</th>
              <th className="w-[130px] px-3 py-2 text-start font-medium whitespace-nowrap">联系人</th>
              <th className="w-[150px] px-3 py-2 text-start font-medium whitespace-nowrap">电话</th>
              <th className="w-[108px] px-3 py-2 text-end font-medium whitespace-nowrap font-mono tabular-nums">台账行数</th>
              <th className="w-[76px] px-3 py-2 text-center font-medium whitespace-nowrap">状态</th>
              <th className="w-[88px] px-3 py-2 text-end font-medium whitespace-nowrap">操作</th>
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
              displayRows.map((supplier) => (
                <tr key={supplier.id} className="border-b border-separator-border last:border-0 hover:bg-background-secondary-hover">
                  <td className="truncate px-3 py-1.5 text-text-primary" title={supplier.name}>{supplier.name}</td>
                  <td className="truncate px-3 py-1.5 text-text-tertiary" title={supplier.contact ?? ""}>{supplier.contact ?? "—"}</td>
                  <td className="truncate px-3 py-1.5 font-mono text-[0.75rem] text-text-tertiary" title={supplier.phone ?? ""}>{supplier.phone ?? "—"}</td>
                  <td className="px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary whitespace-nowrap">{count(supplier.hits)}</td>
                  <td className="px-3 py-1.5 text-center whitespace-nowrap">
                    <span className={supplier.active ? "text-caption-1-semibold text-emerald-500" : "text-caption-1-regular text-text-tertiary"}>
                      {supplier.active ? "在用" : "停用"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-end whitespace-nowrap">
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

      <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
        <p className="text-body-2-regular text-text-tertiary">
          第 {count((page - 1) * pageSize + 1)}–{count(Math.min(page * pageSize, rows.length))} 家，共 {count(rows.length)} 家
          <span className="mx-2 text-text-tertiary/40">·</span>
          其中 {count(used)} 家已被台账引用
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
            每页
            <select
              aria-label="每页条数"
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value);
                setPageSize(next);
                setPage(1);
                savePageSize(next);
                tableRef.current?.scrollTo({ top: 0 });
              }}
              className="h-7 rounded-md border border-border-button-default bg-background-secondary-default px-1.5 font-mono text-caption-1-regular tabular-nums text-text-secondary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            家
          </label>
          <Pagination
            page={page}
            totalPages={totalPages}
            onChange={(next) => {
              setPage(next);
              tableRef.current?.scrollTo({ top: 0 });
            }}
            previousLabel="上一页"
            nextLabel="下一页"
            aria-label="供应商分页"
          />
        </div>
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
    <div className="flex flex-col gap-1">
      <span className="text-caption-1-semibold text-text-tertiary">{label}</span>
      {children}
    </div>
  );
}

/**
 * 参考单价输入框。
 *
 * 不能像原来那样把值反推显示（`priceMicros / 10000` 再 toFixed(4)）：
 * 敲「1.」的瞬间就被换算成 10000，输入框回显「1.0000」，小数点被吃掉，
 * 接着打的小数就接到了后面，最后整段变 NaN 清空——所以只能整段粘贴才填得进去。
 *
 * 这里自己持有一份输入文字：
 * · 打字时只更新文字，同时把能解析的数字同步出去（留空即清空）；
 * · 失焦、回车、以及外部值被重置（例如换了一条物料）时才把文字规范成两位小数。
 */
function PriceInput({
  value,
  onChange,
}: {
  /** 万分之一元 */
  value: number | null;
  onChange: (micros: number | null) => void;
}) {
  const [draft, setDraft] = useState(() => priceInput4(value));
  // 自己刚刚发出去的值。父组件回传的这个值不能拿来改写输入框，
  // 否则打字过程中每敲一位都会被「规范化」一次，末位会被截掉。
  const sent = useRef<number | null>(value);

  useEffect(() => {
    // 只有外部把值改成了别的东西（换了一条物料、表单重置）才重写文字
    if (value === sent.current) return;
    sent.current = value;
    setDraft(priceInput4(value));
  }, [value]);

  const emit = (text: string) => {
    const micros = parsePriceToMicros(text);
    sent.current = micros;
    onChange(micros);
  };

  const normalize = () => {
    // 输入到一半的「1.」「12.」在这里收敛成「1」「12」；非法内容按清空处理
    const micros = parsePriceToMicros(draft);
    setDraft(priceInput4(micros));
    if (micros !== sent.current) {
      sent.current = micros;
      onChange(micros);
    }
  };

  return (
    <Input
      size="small"
      inputMode="decimal"
      placeholder="0.00"
      // 只留数字和小数点，且小数点最多一个：多打的点直接吞掉，不会把整段变成 NaN
      value={draft}
      onChange={(v) => {
        const cleaned = sanitizePriceDraft(v);
        setDraft(cleaned);
        emit(cleaned);
      }}
      onBlur={normalize}
      onKeyDown={(e) => {
        if (e.key === "Enter") normalize();
      }}
    />
  );
}

/** 输入过程中的清洗：非数字字符丢弃，小数点只保留第一个。 */
function sanitizePriceDraft(text: string): string {
  const kept = text.replace(/[^0-9.]/g, "");
  const dot = kept.indexOf(".");
  if (dot < 0) return kept;
  return kept.slice(0, dot + 1) + kept.slice(dot + 1).replace(/\./g, "");
}


/**
 * 可输入下拉（弹窗内用于单位、类型、类别）。
 *
 * 下拉面板通过 createPortal 挂在弹窗容器（AriaModal）根节点下，脱离 ModalBody 的
 * overflow-y-auto 滚动区（避免撑出弹窗滚动条或被裁剪），同时仍处在 Modal DOM 树内部
 * （避免触发 react-aria 的点外部关闭弹窗）。
 *
 * 行为：输入即筛选；↑↓ 移动高亮、Enter 选中、Esc 或点击边框外收起；可直接输入新值。
 */
function CategoryDropdown({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  /** 用于 aria 标签与列表 id：同一弹窗里可能放多个（单位、类型、类别） */
  label: string;
  placeholder?: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [active, setActive] = useState(0);
  // 用户正在打字过滤。不能用 text === value 判断：打字时 onChange 会把 value 同步成同一串，
  // 那样刚输入就被当成「已确认」，列表永远不过滤。
  const [typing, setTyping] = useState(false);
  const [, setTick] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 外部值变化（切换物料）时同步输入框
  useEffect(() => {
    // 打字时父组件会把 value 同步成同一串（onChange 已经传上去），
    // 这时不能清 typing，否则过滤刚设上就被重置。
    setText((prev) => (prev === value ? prev : value));
    setTyping((prev) => (prev && text === value ? prev : false));
  }, [value]);

  // 打字中按包含关系筛；没在打字（刚聚焦、刚选中）就列全部
  const filtered = useMemo(() => {
    const keyword = typing ? text.trim() : "";
    if (!keyword) return options;
    return options.filter((c) => c.includes(keyword));
  }, [typing, text, options]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.querySelectorAll<HTMLElement>("[role='option']")[active];
    item?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // 弹窗内部滚动或窗口缩放时重算浮层坐标
  useEffect(() => {
    if (!open) return;
    const relayout = () => setTick((n) => n + 1);
    window.addEventListener("scroll", relayout, true);
    window.addEventListener("resize", relayout);
    return () => {
      window.removeEventListener("scroll", relayout, true);
      window.removeEventListener("resize", relayout);
    };
  }, [open]);

  // 点击边框外部收起下拉框
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (!wrapRef.current?.contains(target) && !listRef.current?.contains(target)) {
        setOpen(false);
        setTyping(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  // 下拉展开时，Esc 只收下拉，不能连带关掉整个弹窗。
  // react-aria 的 Modal 在 document 上监听 keydown，React 合成事件拦不住它，
  // 所以在 document 捕获阶段抢先用原生监听处理。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      setTyping(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const pick = (next: string) => {
    setText(next);
    onChange(next);
    setTyping(false);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (filtered[active] !== undefined) pick(filtered[active]);
      else setOpen(false);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setTyping(false);
    } else if (e.key === "Tab" && open) {
      setOpen(false);
      setTyping(false);
    }
  };

  const el = open ? wrapRef.current : null;
  const host = el
    ? ((el.closest('[role="dialog"]')?.parentElement ?? el.closest('[role="dialog"]')) as HTMLElement | null)
    : null;
  const rect = el ? el.getBoundingClientRect() : null;
  const hostRect = host ? host.getBoundingClientRect() : null;
  const dropUp = rect ? window.innerHeight - rect.bottom - 16 < 180 && rect.top > window.innerHeight - rect.bottom : false;

  const listbox = open ? (
    <ul
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={`${label}选项`}
      onWheel={(event) => {
        const node = event.currentTarget;
        if (node.scrollHeight <= node.clientHeight) return;
        node.scrollTop += event.deltaY;
        event.stopPropagation();
      }}
      style={
        rect && hostRect
          ? {
              position: "absolute",
              left: rect.left - hostRect.left,
              width: rect.width,
              ...(dropUp
                ? { bottom: hostRect.bottom - rect.top + 4 }
                : { top: rect.bottom - hostRect.top + 4 }),
            }
          : undefined
      }
      className={
        "z-50 max-h-48 overflow-y-auto rounded-xl border border-border-button-hover bg-background-primary-default p-1 shadow-2xl ring-1 ring-black/40 dark:bg-neutral-900 " +
        (rect && hostRect ? "" : "absolute inset-x-0 " + (dropUp ? "bottom-full mb-1" : "top-full mt-1"))
      }
    >
      {filtered.length === 0 ? (
        <li className="px-2.5 py-2 text-caption-1-regular text-text-tertiary">
          没有匹配的{label}，回车或直接保存即可使用新{label}「{text.trim()}」
        </li>
      ) : (
        filtered.map((c, index) => {
          const selected = c === value;
          const highlighted = index === active;
          return (
            <li
              key={c}
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => {
                // 用 mousedown 而不是 click：避免输入框先失焦、菜单先收起
                e.preventDefault();
                pick(c);
              }}
              className={
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-body-2-medium transition-colors " +
                (highlighted ? "bg-dropdown-item-hover-background " : "") +
                (selected ? "text-text-primary" : "text-text-secondary")
              }
            >
              <span className="truncate">{c}</span>
              {selected ? <RiCheckLine className="size-3.5 shrink-0 text-text-primary" aria-hidden /> : null}
            </li>
          );
        })
      )}
    </ul>
  ) : null;

  return (
    <div ref={wrapRef} className={"relative " + (open ? "z-40" : "")}>
      <div className="relative">
        <input
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          value={text}
          placeholder={placeholder ?? `选或输入新${label}`}
          onChange={(e) => {
            setText(e.target.value);
            onChange(e.target.value);
            setActive(0);
            setTyping(true);
            setOpen(true);
          }}
          onFocus={() => {
            setTyping(false);
            setOpen(true);
          }}
          // 焦点一直停在输入框上时（比如刚按过 Enter），再点不会触发 onFocus，这里补上
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={
            "h-9 w-full rounded-lg border bg-background-primary-default ps-2.5 pe-8 text-body-regular text-text-primary outline-none placeholder:text-text-tertiary " +
            (open
              ? "border-border-focus-ring ring-2 ring-border-focus-ring/20"
              : "border-border-button-default hover:border-border-button-hover")
          }
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={`展开${label}列表`}
          onClick={() => setOpen((v) => !v)}
          className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
        >
          <RiArrowDownSLine className={"size-4 transition-transform " + (open ? "rotate-180" : "")} aria-hidden />
        </button>
      </div>

      {listbox ? (host ? createPortal(listbox, host) : listbox) : null}
    </div>
  );
}
