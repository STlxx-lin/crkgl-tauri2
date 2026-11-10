// Tauri 命令客户端。所有数据访问都从这里走；
// 在浏览器里（80 端口只读站）同一个函数名改走 fetch，桌面端没有的写操作直接拒绝。

import { invoke } from "@tauri-apps/api/core";
import type {
  AccessEntry,
  BulkPatch,
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
  SummaryBundle,
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

// ---------- 只读查询：桌面端走 invoke，远程走 HTTP ----------

function qs(filter: LedgerFilter): string {
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
  return params.toString();
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

export function fetchPage(filter: LedgerFilter, page: number, pageSize: number): Promise<LedgerPage> {
  if (isTauri) {
    return call<LedgerPage>("ledger_page", { args: { filter, page, pageSize } });
  }
  return getJson<LedgerPage>(`/api/ledger/page?${qs(filter)}&page=${page}&pageSize=${pageSize}`);
}

export function fetchFacets(): Promise<Facets> {
  if (isTauri) return call<Facets>("ledger_facets");
  return getJson<Facets>("/api/ledger/facets");
}

export function fetchDetail(id: number): Promise<LedgerRow | null> {
  if (isTauri) return call<LedgerRow | null>("ledger_detail", { id });
  return getJson<LedgerRow | null>(`/api/ledger/detail?id=${id}`);
}

export function fetchSummary(filter: LedgerFilter): Promise<SummaryBundle> {
  if (isTauri) return call<SummaryBundle>("summary_bundle", { args: { filter } });
  // 远程端把几个只读接口拼起来，形状与桌面端保持一致
  const base = qs(filter);
  return getJson<null>(`/api/summary/compare?${base}`).then(async (compare) => {
    const [page, monthly, byOwner, byPartner, topOut, topIn] = await Promise.all([
      getJson<LedgerPage>(`/api/ledger/page?${base}&page=1&pageSize=20`),
      getJson<SummaryBundle["monthly"]>(`/api/summary/monthly?${base}`),
      getJson<SummaryBundle["byOwner"]>(`/api/summary?${base}&groupBy=owner&limit=12`),
      getJson<SummaryBundle["byPartner"]>(`/api/summary?${base}&groupBy=partner&limit=12`),
      getJson<SummaryBundle["topOut"]>(`/api/summary/top?${base}&kindOfTop=out&limit=10`),
      getJson<SummaryBundle["topIn"]>(`/api/summary/top?${base}&kindOfTop=in&limit=10`),
    ]);
    return {
      totals: page.totals,
      monthly,
      byOwner,
      byPartner,
      topOut,
      topIn,
      compare,
    };
  });
}

export function exportUrl(filter: LedgerFilter): string {
  return `/api/ledger/export.csv?${qs(filter)}`;
}

// ---------- 写操作：只有桌面端 ----------

export function updateRow(id: number, patch: Partial<LedgerRow>): Promise<void> {
  return call<void>("ledger_update", { args: { id, patch } });
}

export function deleteRow(id: number): Promise<void> {
  return call<void>("ledger_delete", { id });
}

export function exportLedger(filter: LedgerFilter, path: string): Promise<ExportResult> {
  return call<ExportResult>("ledger_export", { args: { filter, page: 1, pageSize: 100 }, path });
}

export function inspectWorkbook(path: string): Promise<WorkbookReport> {
  return call<WorkbookReport>("import_inspect", { path });
}

export function previewImport(path: string, plans?: SheetPlan[]): Promise<PreviewResult> {
  return call<PreviewResult>("import_preview", { args: { path, plans, sampleLimit: 8 } });
}

export function runImport(
  path: string,
  plans: SheetPlan[] | undefined,
  replace: boolean,
  master = true,
): Promise<ImportOutcome> {
  return call<ImportOutcome>("import_run", { args: { path, plans, replace, master } });
}

export function importHistory(): Promise<ImportRecord[]> {
  return call<ImportRecord[]>("import_history");
}

export function deleteImport(id: number): Promise<number> {
  return call<number>("import_delete", { id });
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

export function createVoucher(input: VoucherInput): Promise<number> {
  return call<number>("voucher_create", { args: input });
}

export function updateVoucher(id: number, input: VoucherInput): Promise<void> {
  return call<void>("voucher_update", { id, args: input });
}

export function deleteVoucher(id: number): Promise<number> {
  return call<number>("voucher_delete", { id });
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

export function bulkUpdateRows(ids: number[], patch: BulkPatch): Promise<number> {
  return call<number>("ledger_bulk_update", { args: { ids, patch } });
}

export function bulkDeleteRows(ids: number[]): Promise<number> {
  return call<number>("ledger_bulk_delete", { ids });
}

// ---------- 基础资料 ----------

export function listItems(opts: {
  keyword?: string;
  category?: string | null;
  itemType?: string | null;
  onlyActive?: boolean;
  /** true 只看有图号，false 只看没图号的 */
  withDrawing?: boolean | null;
  limit?: number;
  offset?: number;
}): Promise<Item[]> {
  return call<Item[]>("items_list", {
    keyword: opts.keyword ?? null,
    category: opts.category ?? null,
    itemType: opts.itemType ?? null,
    onlyActive: opts.onlyActive ?? false,
    withDrawing: opts.withDrawing ?? null,
    limit: opts.limit ?? 200,
    offset: opts.offset ?? 0,
  });
}

export function countItems(opts: {
  keyword?: string;
  category?: string | null;
  onlyActive?: boolean;
  withDrawing?: boolean | null;
}): Promise<number> {
  return call<number>("items_count", {
    keyword: opts.keyword ?? null,
    category: opts.category ?? null,
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

// ---------- 单据查询 ----------

export function searchDocs(keyword: string, kind?: Kind | null, limit = 50): Promise<DocHit[]> {
  return call<DocHit[]>("doc_search", { keyword, kind: kind ?? null, limit });
}

export function fetchDocLines(docNo: string, kind: Kind): Promise<LedgerRow[]> {
  return call<LedgerRow[]>("doc_lines", { docNo, kind });
}
