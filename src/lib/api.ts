// Tauri 命令客户端。所有数据访问都从这里走；
// 在浏览器里（80 端口只读站）同一个函数名改走 fetch，桌面端没有的写操作直接拒绝。

import { invoke } from "@tauri-apps/api/core";
import type {
  AccessEntry,
  BulkPatch,
  ClearOutcome,
  DictEntry,
  DictInput,
  DictKind,
  DictKindCount,
  ItemMaster,
  Item,
  ItemInput,
  Supplier,
  SupplierInput,
  MasterStats,
  MasterImportOutcome,
  Kind,
  Voucher,
  DocHit,
  VoucherInput,
  VoucherSummary,
  BootstrapInfo,
  ExportResult,
  Facets,
  ImportOutcome,
  ImportRecord,
  LedgerFilter,
  LedgerPage,
  LedgerRow,
  PreviewResult,
  SheetPlan,
  StockCheckSummary,
  StockIssue,
  StockRow,
  SummaryBundle,
  Warehouse,
  WarehouseDeleteOutcome,
  WarehouseInput,
  WebStatus,
  WorkbookReport,
} from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function assertTauri(): void {
  if (!isTauri) {
    throw new Error("这个操作只能在桌面端做。");
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  assertTauri();
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[invoke ${cmd}] ${message}`);
    throw new Error(message);
  }
}

// ---------- 只读站的仓库选择 ----------
//
// 桌面端每个命令都由 Rust 侧注入当前仓库，前端不用传；只有在浏览器里
// （80 端口只读站）才把选中的仓库拼进查询参数，让每个同事各看各的仓。
// 「全部仓库」只在汇总页有意义，所以单独存一个开关，别污染台账/库存。

let remoteWarehouseId: number | null = null;

export function setRemoteWarehouse(id: number | null): void {
  remoteWarehouseId = id;
  invalidateFacetsCache();
}

// ---------- 只读查询：桌面端走 invoke，远程走 HTTP ----------

function qs(filter: LedgerFilter, mergeAll = false): string {
  const params = new URLSearchParams();
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  };
  put("from", filter.from);
  put("to", filter.to);
  put("kind", filter.kind);
  put("owner", filter.owner);
  put("partner", filter.partner);
  put("buyer", filter.buyer);
  put("keyword", filter.keyword);
  if (filter.flagged) put("flagged", "true");
  put("sort", filter.sort);
  if (filter.desc) put("desc", "true");
  // 只读站：带上选中的仓库；桌面端由命令层注入，不发这个参数
  if (!isTauri) {
    if (mergeAll) put("warehouse", "all");
    else if (remoteWarehouseId !== null) put("warehouse", remoteWarehouseId);
  }
  return params.toString();
}

/** 只读站的仓库参数：库存、筛选候选这些不分仓的接口共用。 */
function whParam(): string {
  if (isTauri || remoteWarehouseId === null) return "";
  return `warehouse=${remoteWarehouseId}`;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // 非 JSON 错误体，原样给出去
    }
    throw new Error(message || `请求失败 (${response.status})`);
  }
  return (await response.json()) as T;
}

export function bootstrap(): Promise<BootstrapInfo> {
  return call<BootstrapInfo>("bootstrap");
}

export function fetchPage(
  filter: LedgerFilter,
  page: number,
  pageSize: number,
  skipTotals = false,
): Promise<LedgerPage> {
  if (isTauri) {
    return call<LedgerPage>("ledger_page", { args: { filter, page, pageSize, skipTotals } });
  }
  return getJson<LedgerPage>(
    `/api/ledger/page?${qs(filter)}&page=${page}&pageSize=${pageSize}${skipTotals ? "&skipTotals=true" : ""}`,
  );
}

let cachedFacets: Facets | null = null;
let facetsPromise: Promise<Facets> | null = null;

export function fetchFacets(forceRefresh = false): Promise<Facets> {
  if (!forceRefresh && cachedFacets) {
    return Promise.resolve(cachedFacets);
  }
  if (!forceRefresh && facetsPromise) {
    return facetsPromise;
  }
  const p = isTauri
    ? call<Facets>("ledger_facets")
    : getJson<Facets>(`/api/ledger/facets?${whParam()}`);
  facetsPromise = p
    .then((res) => {
      cachedFacets = res;
      facetsPromise = null;
      return res;
    })
    .catch((err) => {
      facetsPromise = null;
      throw err;
    });
  return facetsPromise;
}

export function invalidateFacetsCache(): void {
  cachedFacets = null;
  facetsPromise = null;
}

export function fetchDetail(id: number): Promise<LedgerRow | null> {
  if (isTauri) return call<LedgerRow | null>("ledger_detail", { id });
  // 只读站：带上自己选的仓库，避免翻出别仓的行
  const query = whParam();
  return getJson<LedgerRow | null>(`/api/ledger/detail?id=${id}${query ? `&${query}` : ""}`);
}

export function fetchSummary(filter: LedgerFilter, mergeAll = false): Promise<SummaryBundle> {
  if (isTauri) {
    return call<SummaryBundle>("summary_bundle", { args: { filter, mergeAll } });
  }
  // 远程端把几个只读接口并行拼起来，形状与桌面端保持一致
  const base = qs(filter, mergeAll);
  return Promise.all([
    getJson<SummaryBundle["totals"]>(`/api/summary/totals?${base}`),
    getJson<SummaryBundle["monthly"]>(`/api/summary/monthly?${base}`),
    getJson<SummaryBundle["byOwner"]>(`/api/summary?${base}&groupBy=owner&limit=12`),
    getJson<SummaryBundle["byPartner"]>(`/api/summary?${base}&groupBy=partner&limit=12`),
    getJson<SummaryBundle["topOut"]>(`/api/summary/top?${base}&kindOfTop=out&limit=10`),
    getJson<SummaryBundle["topIn"]>(`/api/summary/top?${base}&kindOfTop=in&limit=10`),
    getJson<SummaryBundle["compare"]>(`/api/summary/compare?${base}`),
  ]).then(([totals, monthly, byOwner, byPartner, topOut, topIn, compare]) => ({
    totals,
    monthly,
    byOwner,
    byPartner,
    topOut,
    topIn,
    compare,
  }));
}

export function exportUrl(filter: LedgerFilter): string {
  return `/api/ledger/export.csv?${qs(filter)}`;
}

// ---------- 写操作：只有桌面端 ----------

export async function updateRow(id: number, patch: Partial<LedgerRow>): Promise<void> {
  await call<void>("ledger_update", { args: { id, patch } });
  invalidateFacetsCache();
}

export async function deleteRow(id: number): Promise<void> {
  await call<void>("ledger_delete", { id });
  invalidateFacetsCache();
}

export function exportLedger(filter: LedgerFilter, path: string): Promise<ExportResult> {
  return call<ExportResult>("ledger_export", { args: { filter, page: 1, pageSize: 100 }, path });
}

export function inspectWorkbook(path: string): Promise<WorkbookReport> {
  return call<WorkbookReport>("import_inspect", { path });
}

export function previewImport(path: string, plans?: SheetPlan[], year?: number): Promise<PreviewResult> {
  return call<PreviewResult>("import_preview", { args: { path, plans, sampleLimit: 8, year } });
}

export async function runImport(
  path: string,
  plans: SheetPlan[] | undefined,
  replace: boolean,
  master = true,
  year?: number,
): Promise<ImportOutcome> {
  const outcome = await call<ImportOutcome>("import_run", { args: { path, plans, replace, master, year } });
  invalidateFacetsCache();
  return outcome;
}

export function importHistory(): Promise<ImportRecord[]> {
  return call<ImportRecord[]>("import_history");
}

export async function deleteImport(id: number): Promise<number> {
  const removed = await call<number>("import_delete", { id });
  invalidateFacetsCache();
  return removed;
}

export function webStatus(): Promise<WebStatus> {
  return call<WebStatus>("web_status");
}

export function startWeb(): Promise<WebStatus> {
  return call<WebStatus>("web_start");
}

export function stopWeb(): Promise<void> {
  return call<void>("web_stop");
}

export function accessLog(limit = 100): Promise<AccessEntry[]> {
  return call<AccessEntry[]>("web_access_log", { limit });
}

export function clientLog(level: "info" | "warn" | "error", message: string): void {
  if (!isTauri) return;
  void invoke("client_log", { level, message }).catch(() => undefined);
}

// ---------- 开单 ----------

export async function createVoucher(input: VoucherInput): Promise<number> {
  const id = await call<number>("voucher_create", { args: input });
  invalidateFacetsCache();
  return id;
}

export async function updateVoucher(id: number, input: VoucherInput): Promise<void> {
  await call<void>("voucher_update", { id, args: input });
  invalidateFacetsCache();
}

export async function deleteVoucher(id: number): Promise<number> {
  const removed = await call<number>("voucher_delete", { id });
  invalidateFacetsCache();
  return removed;
}

export function getVoucher(id: number): Promise<Voucher | null> {
  return call<Voucher | null>("voucher_get", { id });
}

export function listVouchers(kind?: Kind | null, limit = 50): Promise<VoucherSummary[]> {
  return call<VoucherSummary[]>("voucher_list", { kind: kind ?? null, limit });
}

export function nextDocNo(kind: Kind, date: string): Promise<string> {
  return call<string>("voucher_next_no", { kind, date });
}

export function fetchItemMaster(
  keyword?: string,
  limit = 200,
  inboundOnly = true,
  inStockOnly = false,
): Promise<ItemMaster[]> {
  return call<ItemMaster[]>("item_master", {
    keyword: keyword ?? null,
    limit,
    inboundOnly,
    inStockOnly,
  });
}

// ---------- 批量 ----------

export async function bulkUpdateRows(ids: number[], patch: BulkPatch): Promise<number> {
  const count = await call<number>("ledger_bulk_update", { args: { ids, patch } });
  invalidateFacetsCache();
  return count;
}

export async function bulkDeleteRows(ids: number[]): Promise<number> {
  const count = await call<number>("ledger_bulk_delete", { ids });
  invalidateFacetsCache();
  return count;
}

// ---------- 基础资料 ----------

/** 物料列表排序键。 */
export type ItemOrder = "code" | "code_desc" | "name" | "newest" | "oldest";

export function listItems(opts: {
  keyword?: string;
  category?: string | null;
  itemType?: string | null;
  onlyActive?: boolean;
  /** true 只看有图号，false 只看没图号的 */
  withDrawing?: boolean | null;
  limit?: number;
  offset?: number;
  /** true 时按建档时间倒序，最新建的在最前 */
  recent?: boolean;
  /** 排序方式；不传按编码升序 */
  order?: ItemOrder;
}): Promise<Item[]> {
  return call<Item[]>("items_list", {
    keyword: opts.keyword ?? null,
    category: opts.category ?? null,
    itemType: opts.itemType ?? null,
    onlyActive: opts.onlyActive ?? false,
    withDrawing: opts.withDrawing ?? null,
    limit: opts.limit ?? 200,
    offset: opts.offset ?? 0,
    recent: opts.recent ?? false,
    order: opts.order ?? null,
  });
}

export function countItems(opts: {
  keyword?: string;
  category?: string | null;
  itemType?: string | null;
  onlyActive?: boolean;
  withDrawing?: boolean | null;
}): Promise<number> {
  return call<number>("items_count", {
    keyword: opts.keyword ?? null,
    category: opts.category ?? null,
    itemType: opts.itemType ?? null,
    onlyActive: opts.onlyActive ?? false,
    withDrawing: opts.withDrawing ?? null,
  });
}

export function createItem(input: ItemInput): Promise<number> {
  return call<number>("item_create", { args: input });
}

export function updateItem(id: number, input: ItemInput): Promise<void> {
  return call<void>("item_update", { id, args: input });
}

export function deleteItem(id: number): Promise<void> {
  return call<void>("item_delete", { id });
}

export function lookupItem(code: string): Promise<Item | null> {
  return call<Item | null>("item_lookup", { code });
}

export function listSuppliers(keyword?: string): Promise<Supplier[]> {
  return call<Supplier[]>("suppliers_list", { keyword: keyword ?? null });
}

export function createSupplier(input: SupplierInput): Promise<number> {
  return call<number>("supplier_create", { args: input });
}

export function updateSupplier(id: number, input: SupplierInput): Promise<void> {
  return call<void>("supplier_update", { id, args: input });
}

export function deleteSupplier(id: number): Promise<void> {
  return call<void>("supplier_delete", { id });
}

export function masterStats(): Promise<MasterStats> {
  return call<MasterStats>("master_stats");
}

export function importMasterWorkbook(path: string): Promise<MasterImportOutcome> {
  return call<MasterImportOutcome>("master_import_workbook", { path });
}

export function backfillMaster(): Promise<[number, number]> {
  return call<[number, number]>("master_backfill");
}

// ---------- 基础资料导出（只有桌面端） ----------

/** 物料导出：筛选口径与列表页一致，导出全部命中行。 */
export function exportItems(
  opts: {
    keyword?: string;
    category?: string | null;
    itemType?: string | null;
    onlyActive?: boolean;
    withDrawing?: boolean | null;
    order?: ItemOrder;
  },
  path: string,
): Promise<ExportResult> {
  return call<ExportResult>("master_items_export", {
    args: {
      keyword: opts.keyword ?? null,
      category: opts.category ?? null,
      itemType: opts.itemType ?? null,
      onlyActive: opts.onlyActive ?? false,
      withDrawing: opts.withDrawing ?? null,
      order: opts.order ?? null,
    },
    path,
  });
}

/** 供应商导出。 */
export function exportSuppliers(keyword: string | undefined, path: string): Promise<ExportResult> {
  return call<ExportResult>("master_suppliers_export", { args: { keyword: keyword ?? null }, path });
}

/** 字典导出：按类别 + 关键字 + 只看在用。 */
export function exportDict(
  kind: DictKind,
  keyword: string | undefined,
  onlyActive: boolean,
  path: string,
): Promise<ExportResult> {
  return call<ExportResult>("master_dict_export", {
    args: { kind, keyword: keyword ?? null, onlyActive },
    path,
  });
}

// ---------- 字典（单位 / 类别 / 类型 / 出库部门 / 采购人） ----------

export function listDict(kind: DictKind, keyword?: string, onlyActive = false): Promise<DictEntry[]> {
  return call<DictEntry[]>("dict_list", {
    kind,
    keyword: keyword ?? null,
    onlyActive,
  });
}

export function dictCounts(): Promise<DictKindCount[]> {
  return call<DictKindCount[]>("dict_counts");
}

export function createDict(input: DictInput): Promise<number> {
  return call<number>("dict_create", { args: input });
}

/** 改字典值会同步改写台账/物料里用到它的行，返回受影响行数。 */
export async function updateDict(id: number, input: DictInput): Promise<number> {
  const touched = await call<number>("dict_update", { id, args: input });
  invalidateFacetsCache();
  return touched;
}

export function deleteDict(id: number): Promise<void> {
  return call<void>("dict_delete", { id });
}

export function syncDict(): Promise<number> {
  return call<number>("dict_sync");
}

// ---------- 单据查询 ----------

export function searchDocs(keyword: string, kind?: Kind | null, limit = 50): Promise<DocHit[]> {
  return call<DocHit[]>("doc_search", { keyword, kind: kind ?? null, limit });
}

export function fetchDocLines(docNo: string, kind: Kind): Promise<LedgerRow[]> {
  return call<LedgerRow[]>("doc_lines", { docNo, kind });
}

// ---------- 库存 ----------

export function fetchStockReport(opts: {
  keyword?: string;
  onlyNegative?: boolean;
  limit?: number;
  offset?: number;
}): Promise<StockRow[]> {
  if (!isTauri) {
    const params = new URLSearchParams();
    if (opts.keyword) params.set("keyword", opts.keyword);
    if (opts.onlyNegative) params.set("onlyNegative", "true");
    params.set("limit", String(opts.limit ?? 500));
    params.set("offset", String(opts.offset ?? 0));
    if (remoteWarehouseId !== null) params.set("warehouse", String(remoteWarehouseId));
    return getJson<StockRow[]>(`/api/stock?${params}`);
  }
  return call<StockRow[]>("stock_report", {
    args: {
      keyword: opts.keyword ?? null,
      onlyNegative: opts.onlyNegative ?? false,
      limit: opts.limit ?? 500,
      offset: opts.offset ?? 0,
    },
  });
}

export function countStock(keyword?: string, onlyNegative = false): Promise<number> {
  if (!isTauri) {
    const params = new URLSearchParams();
    if (keyword) params.set("keyword", keyword);
    if (onlyNegative) params.set("onlyNegative", "true");
    if (remoteWarehouseId !== null) params.set("warehouse", String(remoteWarehouseId));
    return getJson<number>(`/api/stock/count?${params}`);
  }
  return call<number>("stock_count", { keyword: keyword ?? null, onlyNegative });
}

/** 只读站一次拿回清单与汇总，省一次请求。 */
export async function fetchStockCheck(): Promise<{ issues: StockIssue[]; summary: StockCheckSummary }> {
  if (!isTauri) {
    return getJson<{ issues: StockIssue[]; summary: StockCheckSummary }>(`/api/stock/check?${whParam()}`);
  }
  const [issues, summary] = await Promise.all([
    call<StockIssue[]>("stock_check", { limit: 300 }),
    call<StockCheckSummary>("stock_check_summary"),
  ]);
  return { issues, summary };
}

// ---------- 仓库 ----------

export function listWarehouses(): Promise<Warehouse[]> {
  return call<Warehouse[]>("warehouse_list");
}

export function createWarehouse(input: WarehouseInput): Promise<number> {
  return call<number>("warehouse_create", { args: input });
}

export function updateWarehouse(id: number, input: WarehouseInput): Promise<void> {
  return call<void>("warehouse_update", { id, args: input });
}

export async function deleteWarehouse(id: number, force = false): Promise<WarehouseDeleteOutcome> {
  const outcome = await call<WarehouseDeleteOutcome>("warehouse_delete", { id, force });
  // 删掉的那个仓的筛选候选、行数缓存都不能再用
  invalidateFacetsCache();
  return outcome;
}

/** 切换当前仓库：只写设置，数据不动。 */
export async function switchWarehouse(id: number): Promise<void> {
  await call<void>("warehouse_switch", { id });
  invalidateFacetsCache();
}

/** 只读站：仓库清单（浏览器里没有 Tauri 桥）。 */
export function fetchWarehouses(): Promise<{ warehouses: Warehouse[]; activeWarehouseId: number }> {
  return getJson<{ warehouses: Warehouse[]; activeWarehouseId: number }>("/api/warehouses");
}

// ---------- 数据管理 ----------

export async function clearData(includeMaster = false): Promise<ClearOutcome> {
  const outcome = await call<ClearOutcome>("data_clear", { includeMaster });
  invalidateFacetsCache();
  return outcome;
}

// ---------- 后台与开机自启 ----------

/** 当前程序是否已登记开机自启（只认指向本 exe 的那条）。 */
export function autostartStatus(): Promise<boolean> {
  return call<boolean>("autostart_status");
}

/** 开 / 关开机自启；返回写完之后读回的真实状态。 */
export function autostartSet(enabled: boolean): Promise<boolean> {
  return call<boolean>("autostart_set", { enabled });
}
