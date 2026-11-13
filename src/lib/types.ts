// 与 Rust 侧 serde 结构一一对应。字段名统一 camelCase。

export type Kind = "in" | "out";

export interface LedgerFilter {
  from?: string | null;
  to?: string | null;
  kind?: Kind | null;
  owner?: string | null;
  partner?: string | null;
  buyer?: string | null;
  keyword?: string | null;
  flagged?: boolean;
  sort?: "date" | "amount" | "qty" | "name" | null;
  desc?: boolean;
}

export interface LedgerRow {
  id: number;
  kind: Kind;
  docDate: string | null;
  docNo: string | null;
  deliveryNo: string | null;
  itemCode: string | null;
  itemName: string | null;
  spec: string | null;
  unit: string | null;
  qty: number | null;
  priceMicros: number | null;
  amountCents: number | null;
  remark: string | null;
  partner: string | null;
  buyer: string | null;
  owner: string | null;
  receiver: string | null;
  flags: string[];
  sheet: string;
  rowNo: number;
  importId: number | null;
  createdAt: string | null;
}

export interface LedgerTotals {
  rows: number;
  inRows: number;
  outRows: number;
  amountInCents: number;
  amountOutCents: number;
  qtyIn: number;
  qtyOut: number;
  docCount: number;
  itemCount: number;
}

export interface LedgerPage {
  rows: LedgerRow[];
  total: number;
  page: number;
  pageSize: number;
  totals: LedgerTotals;
}

export interface Facets {
  owners: string[];
  partners: string[];
  buyers: string[];
  minDate: string | null;
  maxDate: string | null;
  itemCount: number;
  inRows: number;
  outRows: number;
}

export interface GroupRow {
  key: string;
  inRows: number;
  outRows: number;
  inQty: number;
  outQty: number;
  amountInCents: number;
  amountOutCents: number;
}

export interface TopItem {
  itemCode: string | null;
  itemName: string | null;
  unit: string | null;
  amountCents: number;
  qty: number;
  rows: number;
}

export interface MonthPoint {
  month: string;
  amountInCents: number;
  amountOutCents: number;
  inRows: number;
  outRows: number;
}

export interface PeriodCompare {
  now: GroupRow;
  previous: GroupRow;
  previousLabel: string;
}

export interface SummaryBundle {
  totals: LedgerTotals;
  monthly: MonthPoint[];
  byOwner: GroupRow[];
  byPartner: GroupRow[];
  topOut: TopItem[];
  topIn: TopItem[];
  compare: PeriodCompare | null;
}

export interface Issue {
  sheet: string;
  rowNo: number;
  message: string;
}

export interface HeaderGuess {
  column: number;
  header: string;
  field: string | null;
}

/** 月度进销存宽表在向导里的摘要。 */
export interface PivotSheetInfo {
  /** 认出的月份；null 表示表名认不出，会跳过 */
  month: number | null;
  /** 逐日网格天数 */
  days: number;
  /** 真实物料行数（不含尾部填充行） */
  items: number;
  /** 尾部「编码=0」的填充行 */
  fillerRows: number;
  /** 日格里的非零笔数 */
  flowCells: number;
  /** 有期初结存的物料数 */
  openingItems: number;
  /** 源表「现结存」非零的物料数 */
  closingItems: number;
}

export interface SheetReport {
  name: string;
  rows: number;
  nonEmptyRows: number;
  detail: boolean;
  /** 主数据表（供应商名称 / 物料编号 / 基础信息），写进基础资料，不进台账 */
  master: boolean;
  /** 月度「库存进销存报表」宽表：一行一物料 + 逐日入库/出库网格 */
  pivot: boolean;
  pivotInfo?: PivotSheetInfo | null;
  note: string;
  headers: HeaderGuess[];
  sample: string[][];
}

export interface WorkbookReport {
  path: string;
  fileName: string;
  sizeBytes: number;
  sheets: SheetReport[];
}

export interface DraftRow {
  sheet: string;
  rowNo: number;
  kind: Kind | "";
  docDate: string;
  docNo: string;
  deliveryNo: string;
  itemCode: string;
  itemName: string;
  location: string;
  spec: string;
  unit: string;
  qty: number | null;
  priceMicros: number | null;
  amountCents: number | null;
  remark: string;
  partner: string;
  buyer: string;
  owner: string;
  receiver: string;
  flags: string[];
}

export interface SheetPlan {
  name: string;
  mapping: Record<string, string>;
  mode?: "replace" | "append" | null;
}

export interface PivotPreviewSummary {
  months: number[];
  totalItems: number;
  locatedItems: number;
  openingRows: number;
  dailyRows: number;
  residualRows: number;
  adjustRows: number;
  correctionRows: number;
  fillerRows: number;
  corrections: string[];
}

export interface SheetPreview {
  name: string;
  /** `in` / `out`，或 `pivot`（月度进销存宽表拆出来的流水） */
  kind: Kind | "pivot";
  rows: number;
  skipped: number;
  flagged: number;
  issues: Issue[];
  sample: DraftRow[];
  pivotSummary?: PivotPreviewSummary | null;
}

export interface PreviewResult {
  sheets: SheetPreview[];
  totalRows: number;
  totalIssues: number;
  flaggedRows: number;
}

export interface SheetSummary {
  name: string;
  /** `in` / `out`，或 `pivot`（月度进销存宽表拆出来的流水） */
  kind: Kind | "pivot";
  rows: number;
  skipped: number;
}

export interface ImportOutcome {
  importId: number;
  fileName: string;
  rows: number;
  skipped: number;
  flagged: number;
  replaced: number;
  issues: Issue[];
  sheets: SheetSummary[];
  duplicateOf: number | null;
  /** 顺带导入的基础资料结果 */
  master: MasterImportOutcome | null;
  /** 基础资料导入失败的提示（台账已写成功） */
  masterError: string | null;
}
export interface ImportRecord {
  id: number;
  fileName: string;
  fileHash: string;
  importedAt: string;
  rowCount: number;
  skippedCount: number;
  note: string | null;
  liveRows: number;
}

export interface WebStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  requestedPort: number;
  error: string | null;
  urls: string[];
  staticReady: boolean;
  startedAt: string | null;
}

export interface AccessEntry {
  at: string;
  ip: string;
  path: string;
  status: number;
}

export interface BootstrapInfo {
  appVersion: string;
  schemaVersion: number;
  dbPath: string;
  rowCount: number;
  importCount: number;
  minDate: string | null;
  maxDate: string | null;
  inRows: number;
  outRows: number;
  web: WebStatus;
  startupImport: ImportOutcome | null;
  lastError: string | null;
  sampleWorkbooks: string[];
}

export interface ExportResult {
  path: string;
  rows: number;
}

// ---------- 开单 ----------

export interface VoucherLineInput {
  /** 送货单号：纸单上逐行填 */
  deliveryNo?: string | null;
  itemCode?: string | null;
  itemName?: string | null;
  spec?: string | null;
  unit?: string | null;
  qty?: number | null;
  /** 单价（分）。出库没有单价。 */
  priceMicros?: number | null;
  remark?: string | null;
}

export interface VoucherInput {
  kind: Kind;
  docNo?: string | null;
  docDate?: string | null;
  partner?: string | null;
  deliveryNo?: string | null;
  buyer?: string | null;
  owner?: string | null;
  receiver?: string | null;
  remark?: string | null;
  lines: VoucherLineInput[];
}

export interface VoucherLine {
  id: number;
  ledgerId: number;
  deliveryNo: string | null;
  itemCode: string | null;
  itemName: string | null;
  spec: string | null;
  unit: string | null;
  qty: number | null;
  priceMicros: number | null;
  amountCents: number | null;
  remark: string | null;
}

export interface Voucher {
  id: number;
  kind: Kind;
  docNo: string;
  docDate: string;
  partner: string | null;
  deliveryNo: string | null;
  buyer: string | null;
  owner: string | null;
  receiver: string | null;
  remark: string | null;
  rowCount: number;
  amountCents: number;
  createdAt: string;
  sheet: string;
  lines: VoucherLine[];
}

export interface VoucherSummary {
  id: number;
  kind: Kind;
  docNo: string;
  docDate: string;
  partner: string | null;
  owner: string | null;
  rowCount: number;
  amountCents: number;
  createdAt: string;
  /** 第一行明细的物料名，供应商为空时用它显示 */
  firstItem: string | null;
}

export interface ItemMaster {
  itemCode: string;
  itemName: string;
  unit: string | null;
  spec: string | null;
  /** 最近一次入库单价（万分之一元） */
  lastPriceMicros: number | null;
  hits: number;
  /** 当前结存数量（入库合计 - 出库合计） */
  stockQty: number;
}

/** 批量改只动描述性字段，数量金额必须逐行确认。 */
export interface BulkPatch {
  owner?: string | null;
  buyer?: string | null;
  remark?: string | null;
}

// ---------- 基础资料 ----------

export interface Item {
  id: number;
  itemCode: string;
  itemName: string;
  category: string | null;
  unit: string | null;
  priceMicros: number | null;
  spec: string | null;
  /** 外购件 / 加工件 */
  itemType: string | null;
  /** 图号 */
  drawingNo: string | null;
  /** 库位（D-01-02-4F） */
  location: string | null;
  owner: string | null;
  supplier: string | null;
  remark: string | null;
  active: boolean;
  /** 结存数量（只在开单候选里有值，主数据列表不带） */
  stockQty?: number | null;
}

export interface ItemInput {
  itemCode: string;
  itemName: string;
  category?: string | null;
  unit?: string | null;
  priceMicros?: number | null;
  spec?: string | null;
  itemType?: string | null;
  drawingNo?: string | null;
  /** 库位（D-01-02-4F） */
  location?: string | null;
  owner?: string | null;
  supplier?: string | null;
  remark?: string | null;
  active?: boolean;
}

export interface Supplier {
  id: number;
  name: string;
  contact: string | null;
  phone: string | null;
  remark: string | null;
  active: boolean;
  hits: number;
}

export interface SupplierInput {
  name: string;
  contact?: string | null;
  phone?: string | null;
  remark?: string | null;
  active?: boolean;
}

export interface CategoryCount {
  category: string;
  count: number;
}

// ---------- 字典（单位 / 类别 / 类型 / 出库部门 / 采购人） ----------

export type DictKind = "unit" | "category" | "item_type" | "owner" | "buyer";

/** 与 Rust 侧 dict::KINDS 同序，界面上的显示顺序也照它。 */
export const DICT_KINDS: { kind: DictKind; label: string; hint: string }[] = [
  { kind: "unit", label: "单位", hint: "个 / 只 / 件 / 米…开单明细的单位列" },
  { kind: "category", label: "类别", hint: "五金类 / 轴承类 / 电器类…物料分类" },
  { kind: "item_type", label: "类型", hint: "外购件 / 加工件" },
  { kind: "owner", label: "出库部门", hint: "台账里的「归属」，出库单表头" },
  { kind: "buyer", label: "采购人", hint: "入库单签字与台账采购人" },
];

export interface DictEntry {
  id: number;
  kind: DictKind;
  value: string;
  sortNo: number;
  hits: number;
  remark: string | null;
  active: boolean;
  /** 台账/物料里实际用到的行数 */
  used: number;
}

export interface DictInput {
  kind: DictKind;
  value: string;
  sortNo?: number | null;
  remark?: string | null;
  active?: boolean;
}

export interface DictKindCount {
  kind: DictKind;
  label: string;
  total: number;
  active: number;
}

export interface MasterStats {
  items: number;
  itemsActive: number;
  suppliers: number;
  categories: CategoryCount[];
  itemTypes: CategoryCount[];
  /** 已填图号的物料数 */
  withDrawing: number;
  /** 加工件里缺图号、需要补的数量 */
  missingDrawing: number;
}

export interface MasterImportOutcome {
  itemsAdded: number;
  itemsUpdated: number;
  suppliersAdded: number;
  suppliersSkipped: number;
  sheetsFound: string[];
  message: string;
}

/** 单据查询结果：本机开单（可编辑）或 Excel 导入（只读）。 */
export interface DocHit {
  docNo: string;
  kind: Kind;
  docDate: string | null;
  partner: string | null;
  owner: string | null;
  buyer: string | null;
  deliveryNo: string | null;
  rowCount: number;
  amountCents: number;
  source: "voucher" | "import";
  voucherId: number | null;
}

// ---------- 库存 ----------

export interface StockRow {
  itemCode: string;
  itemName: string;
  location: string | null;
  spec: string | null;
  unit: string | null;
  inQty: number;
  outQty: number;
  stockQty: number;
  inRows: number;
  outRows: number;
  lastPriceMicros: number | null;
  lastDate: string | null;
}

export interface StockIssue {
  /** negative_stock / missing_code / bad_qty */
  kind: string;
  ledgerId: number | null;
  itemCode: string | null;
  itemName: string | null;
  unit: string | null;
  qty: number | null;
  docNo: string | null;
  docDate: string | null;
  kindLabel: string | null;
  detail: string;
}

export interface StockCheckSummary {
  negativeItems: number;
  negativeGap: number;
  missingCodeRows: number;
  badQtyRows: number;
}

export interface ClearOutcome {
  ledgerRows: number;
  vouchers: number;
  imports: number;
  items: number;
  suppliers: number;
  dict: number;
}
