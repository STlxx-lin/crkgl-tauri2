import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowLeftRightLine,
  RiDeleteBinLine,
  RiFileAddLine,
  RiFileList3Line,
  RiPrinterLine,
  RiSearchLine,
  RiSidebarFoldLine,
  RiSidebarUnfoldLine,
  RiSaveLine,
} from "@remixicon/react";
import {
  createSupplier,
  createVoucher,
  deleteVoucher,
  listSuppliers,
  getVoucher,
  isTauri,
  fetchDocLines,
  listDict,
  listVouchers,
  nextDocNo,
  searchDocs,
  updateVoucher,
} from "../lib/api";
import type { DocHit, Item, Kind, LedgerRow, Supplier, Voucher, VoucherLineInput, VoucherSummary } from "../lib/types";
import { amount, count, date, flagLabel, kindLabel, money, priceInput4, priceText, qty } from "../lib/format";
import { Button } from "@/components/base/buttons/button";
import { AlertDialog, Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { toast } from "@/components/base/toast/toast";
import { Spinner } from "@/components/base/spinner/spinner";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";
import { ItemPicker } from "../components/ItemPicker";
import { ComboPicker, type PickerOption } from "../components/ComboPicker";
import { QuickAddDialog, type QuickAddKind } from "../components/QuickAddDialog";
import { PrintVoucher } from "../components/PrintVoucher";
import {
  onBuyerChange,
  onPrintAfterSaveChange,
  saveBuyer,
  savePrintAfterSave,
  storedBuyer,
  storedPrintAfterSave,
} from "../lib/voucherPrefs";

type Mode = { kind: Kind; id: number | null };

interface DraftLine {
  key: string;
  /** 送货单号（入库逐行填，出库为空） */
  deliveryNo: string;
  itemCode: string;
  itemName: string;
  unit: string;
  qty: string;
  price: string;
  remark: string;
  spec?: string;
}

interface HeadDraft {
  docNo: string;
  docDate: string;
  partner: string;
  buyer: string;
  owner: string;
  receiver: string;
  /** 仓管签字（纸单底部有，只做记录） */
  storekeeper: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// 单据查询侧栏的展开状态：按本机记住，下次开单还是同一副布局
const DOC_SEARCH_KEY = "ledger.voucher.docSearchOpen";

function storedDocSearchOpen(): boolean {
  try {
    // 默认展开：第一次用的人需要看到这个入口
    return window.localStorage.getItem(DOC_SEARCH_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveDocSearchOpen(open: boolean): void {
  try {
    window.localStorage.setItem(DOC_SEARCH_KEY, open ? "1" : "0");
  } catch {
    // 存不下也不影响本次会话
  }
}

let lineSeq = 0;
function blankLine(): DraftLine {
  lineSeq += 1;
  return {
    key: `l${lineSeq}`,
    deliveryNo: "",
    itemCode: "",
    itemName: "",
    unit: "",
    qty: "",
    price: "",
    remark: "",
    spec: "",
  };
}

function blankHead(kind: Kind): HeadDraft {
  return {
    docNo: "",
    docDate: today(),
    partner: "",
    buyer: kind === "in" ? storedBuyer() : "",
    owner: "",
    receiver: "",
    storekeeper: "",
  };
}

const VOUCHER_DRAFT_KEY = "ledger.voucher.draft";
/** 本机开单列表一次最多加载多少张。 */
const HISTORY_CAP = 500;
/** 点一次「加载更早」多取多少张。 */
const HISTORY_STEP = 50;

interface VoucherDraft {
  mode: Mode;
  head: HeadDraft;
  lines: DraftLine[];
}

/** 草稿里的一行必须是「字段都在、且都是字符串」的对象。 */
function isDraftLine(value: unknown): value is DraftLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return (
    typeof line.key === "string" &&
    typeof line.deliveryNo === "string" &&
    typeof line.itemCode === "string" &&
    typeof line.itemName === "string" &&
    typeof line.unit === "string" &&
    typeof line.qty === "string" &&
    typeof line.price === "string" &&
    typeof line.remark === "string" &&
    (line.spec === undefined || typeof line.spec === "string")
  );
}

function sanitizeHead(value: unknown, kind: Kind): HeadDraft | null {
  if (!value || typeof value !== "object") return null;
  const head = value as Record<string, unknown>;
  const text = (key: keyof HeadDraft) => {
    const v = head[key];
    return typeof v === "string" ? v : null;
  };
  const docNo = text("docNo");
  const docDate = text("docDate");
  const partner = text("partner");
  const buyer = text("buyer");
  const owner = text("owner");
  const receiver = text("receiver");
  const storekeeper = text("storekeeper");
  if ([docNo, docDate, partner, buyer, owner, receiver, storekeeper].some((v) => v === null)) {
    return null;
  }
  const fallback = blankHead(kind);
  return {
    docNo: docNo ?? "",
    // 日期非法时退回今天，否则开单会被后端直接拒绝
    docDate: docDate && /^\d{4}-\d{2}-\d{2}$/.test(docDate) ? docDate : fallback.docDate,
    partner: partner ?? "",
    buyer: buyer ?? fallback.buyer,
    owner: owner ?? "",
    receiver: receiver ?? "",
    storekeeper: storekeeper ?? "",
  };
}

/**
 * 读本机草稿。
 *
 * 只校验最外层（mode 合法、lines 是非空数组）不够：`lines` 里的元素可能是
 * 数字、null、缺字段的旧版本对象，渲染时 `line.qty.trim()` 直接抛 TypeError，
 * 而这段代码在首屏渲染路径上，于是应用一启动就白屏、还清不掉本地存储。
 * 这里逐行校验，任何一行不合法就整份丢弃。
 */
function loadVoucherDraft(): VoucherDraft | null {
  try {
    const raw = window.localStorage.getItem(VOUCHER_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const draft = parsed as Record<string, unknown>;
    const mode = draft.mode as Record<string, unknown> | undefined;
    if (!mode || (mode.kind !== "in" && mode.kind !== "out")) return null;
    const id = mode.id;
    if (id !== null && (typeof id !== "number" || !Number.isFinite(id))) return null;
    const kind = mode.kind as Kind;
    if (!Array.isArray(draft.lines) || draft.lines.length === 0) return null;
    if (!draft.lines.every(isDraftLine)) return null;
    const head = sanitizeHead(draft.head, kind);
    if (!head) return null;
    return { mode: { kind, id: id as number | null }, head, lines: draft.lines };
  } catch {
    // 解析失败或本地存储被禁用：当作没有草稿
    clearVoucherDraft();
  }
  return null;
}

function clearVoucherDraft(): void {
  try {
    window.localStorage.removeItem(VOUCHER_DRAFT_KEY);
  } catch {
    // 忽略存储错误
  }
}

function saveVoucherDraft(draft: VoucherDraft): void {
  try {
    window.localStorage.setItem(VOUCHER_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // 忽略存储错误
  }
}

/**
 * 开单表格物料名称旁边的规格型号标签。
 * 默认以轻巧的徽标胶囊显示；点击可快速内联编辑修改。
 */
function SpecBadge({
  value,
  showAdd,
  onChange,
}: {
  value?: string;
  showAdd?: boolean;
  onChange: (val: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? "");

  useEffect(() => {
    setText(value ?? "");
  }, [value]);

  if (editing) {
    return (
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false);
          onChange(text.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setEditing(false);
            onChange(text.trim());
          } else if (e.key === "Escape") {
            setEditing(false);
            setText(value ?? "");
          }
        }}
        className="h-6 w-24 shrink-0 rounded border border-border-focus-ring bg-background-primary-default px-1.5 font-mono text-[0.6875rem] text-text-primary outline-none"
        placeholder="规格型号"
      />
    );
  }

  if (value && value.trim()) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={`规格型号: ${value}（点击修改）`}
        className="inline-flex max-w-[120px] shrink-0 items-center truncate rounded bg-background-secondary-hover px-1.5 py-0.5 font-mono text-[0.6875rem] text-text-secondary ring-1 ring-border-button-default transition-colors hover:border-border-button-hover hover:text-text-primary"
      >
        {value}
      </button>
    );
  }

  if (showAdd) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="添加规格型号"
        className="shrink-0 text-[0.6875rem] text-text-tertiary opacity-0 transition-opacity hover:text-text-secondary group-hover/name:opacity-100"
      >
        +规格
      </button>
    );
  }

  return null;
}

/**
 * 开单页：入库单 / 出库单。
 *
 * 表单结构照 Excel 里那两张单子：表头（供应商/送货单号/单据编号、归属/出库时间/单据编号）
 * 加明细行（物料编码、名称、单位、数量、单价、合计、备注）。
 * 选物料时从历史台账带出单位与最近单价，减少重复录入。
 */
export function VoucherScreen({ active = true, onChanged }: { active?: boolean; onChanged: () => void }) {
  const initialDraft = useRef(loadVoucherDraft());
  const [mode, setMode] = useState<Mode>(() => initialDraft.current?.mode ?? { kind: "in", id: null });
  const [head, setHead] = useState<HeadDraft>(() => initialDraft.current?.head ?? blankHead("in"));
  const [lines, setLines] = useState<DraftLine[]>(() => initialDraft.current?.lines ?? [blankLine()]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  // 字典候选：单位按行选，出库部门与采购人在表头选
  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [ownerOptions, setOwnerOptions] = useState<string[]>([]);
  const [buyerOptions, setBuyerOptions] = useState<string[]>([]);
  const [history, setHistory] = useState<VoucherSummary[]>([]);
  // 列表分页：默认 50，点「加载更早」一次多取 50，最多 HISTORY_CAP 张
  const [historyLimit, setHistoryLimit] = useState(HISTORY_STEP);
  // 保存后是否自动打印（打印完毕后原单继续留在表单里，方便接着编号）
  const [printAfterSave, setPrintAfterSave] = useState(() => storedPrintAfterSave());
  // 本机开单列表：按编号/供应商筛 + 入库出库筛选
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyKind, setHistoryKind] = useState<"all" | "in" | "out">("all");
  const [busy, setBusy] = useState(false);
  // 待删单据只认 id / 单号 / 行数，不回查已加载列表：
  // history 只装最近 50 张，从「单据查询」打开较早的单时回查会拿不到，
  // 点删除就什么都不发生（没有 toast、没有确认框），像程序卡住了。
  const [pendingDelete, setPendingDelete] = useState<{ id: number; docNo: string; rowCount: number } | null>(null);
  // A4 打印：用当前录入内容出稿，未保存也能先打一份校样
  const [printing, setPrinting] = useState(false);
  // 快速新增：录单到一半补一条物料/供应商
  const [quickAdd, setQuickAdd] = useState<QuickAddKind | null>(null);
  // 新建物料后要填进哪一行（null 表示新加一行）
  const quickAddTargetLine = useRef<string | null>(null);
  // 单据查询：跨「本机开单」与「Excel 导入」两种来源
  const [showDocSearch, setShowDocSearch] = useState(() => storedDocSearchOpen());
  const [docQuery, setDocQuery] = useState("");
  const [docHits, setDocHits] = useState<DocHit[] | null>(null);
  const [docSearching, setDocSearching] = useState(false);
  const [viewingImport, setViewingImport] = useState<{ hit: DocHit; lines: LedgerRow[] } | null>(null);
  // 本机单据详情：点列表只“看”，不灌进左边表单，避免冲掉正在录的单
  const [viewingVoucher, setViewingVoucher] = useState<Voucher | null>(null);
  // 正在查看详情的打印稿
  const [printingView, setPrintingView] = useState<Voucher | null>(null);
  const dirty = useRef(false);
  // 快捷键里要调用 submit，但它定义在后面：用 ref 存最新引用，监听只挂一次
  const submitRef = useRef<() => void>(() => {});

  const loadHistory = useCallback(async () => {
    if (!isTauri) return;
    try {
      setHistory(await listVouchers(null, historyLimit));
    } catch (err) {
      toast("单据列表读取失败", { description: String(err), status: "error" });
    }
  }, [historyLimit]);

  const loadSuppliers = useCallback(async () => {
    if (!isTauri) return;
    try {
      const list = await listSuppliers();
      setSuppliers(list.filter((s) => s.active));
    } catch {
      // 供应商只是便利功能，读不到不影响手填
    }
  }, []);

  /** 字典候选：单位、出库部门、采购人。读不到就退回手输，不挡开单。 */
  const loadDicts = useCallback(async () => {
    if (!isTauri) return;
    const read = async (kind: "unit" | "owner" | "buyer") => {
      try {
        const list = await listDict(kind, undefined, true);
        return list.map((entry) => entry.value);
      } catch {
        return [] as string[];
      }
    };
    const [units, owners, buyers] = await Promise.all([read("unit"), read("owner"), read("buyer")]);
    setUnitOptions(units);
    setOwnerOptions(owners);
    setBuyerOptions(buyers);
  }, []);

  const freshDocNo = useCallback(async (kind: Kind, docDate: string) => {
    try {
      const no = await nextDocNo(kind, docDate || today());
      setHead((prev) => ({ ...prev, docNo: prev.docNo.trim() ? prev.docNo : no }));
    } catch (err) {
      toast("取号失败", { description: String(err), status: "error" });
    }
  }, []);

  useEffect(() => {
    loadSuppliers();
    loadDicts();
    loadHistory();
  }, [loadSuppliers, loadDicts, loadHistory]);

  // 从其他页面切回开单时，静默拉取最新的供应商、字典与历史单据，保证下拉框最新且不影响正在输入的表单
  const wasActive = useRef(active);
  useEffect(() => {
    if (!wasActive.current && active) {
      loadSuppliers();
      loadDicts();
      loadHistory();
    }
    wasActive.current = active;
  }, [active, loadSuppliers, loadDicts, loadHistory]);

  // 正在输入时自动防抖暂存草稿，防止误刷新或关闭应用丢失
  useEffect(() => {
    const hasContent =
      head.partner.trim() !== "" ||
      head.owner.trim() !== "" ||
      head.receiver.trim() !== "" ||
      head.buyer.trim() !== (mode.kind === "in" ? storedBuyer() : "") ||
      lines.some(
        (l) =>
          l.deliveryNo.trim() !== "" ||
          l.itemCode.trim() !== "" ||
          l.itemName.trim() !== "" ||
          l.qty.trim() !== "" ||
          l.price.trim() !== "" ||
          l.remark.trim() !== "",
      );

    if (hasContent || dirty.current) {
      const timer = window.setTimeout(() => {
        saveVoucherDraft({ mode, head, lines });
      }, 250);
      return () => window.clearTimeout(timer);
    }
  }, [mode, head, lines]);

  // 设置里改了「保存后打印」，编辑器跟着换
  useEffect(() => onPrintAfterSaveChange(setPrintAfterSave), []);

  // 每次渲染后把最新的 submit 挂到 ref 上，快捷键永远调到当前闭包
  useEffect(() => {
    submitRef.current = () => {
      void submit();
    };
  });

  /**
   * 录入快捷键：
   * · Ctrl/⌘+S 保存（和点「保存单据」等价）
   * · 在明细输入框里按回车，跳到本行下一个输入框；最后一个跳到下一行
   * 都在录入区生效，列表里的输入框不受影响。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 开单页可能被挂在别的页面后面（App 用 active 控制显隐），
      // 不在这一页时全局快捷键不能去提交那张看不见的表单。
      if (!active) return;
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        submitRef.current();
        return;
      }
      if (event.key !== "Enter" || meta || event.shiftKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (!target || target.tagName !== "INPUT") return;
      if (!target.closest("tbody")) return;

      // 同一表格内的可输入框按 DOM 顺序往后找
      const table = target.closest("table");
      if (!table) return;
      const inputs = Array.from(table.querySelectorAll<HTMLInputElement>("tbody input:not([disabled])"));
      const index = inputs.indexOf(target as HTMLInputElement);
      if (index < 0 || index === inputs.length - 1) return;
      event.preventDefault();
      inputs[index + 1]?.focus();
      inputs[index + 1]?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // 保存过新采购人后，正在编辑的空白新单跟着换默认值（已填的不动）
  useEffect(
    () =>
      onBuyerChange((buyer) => {
        setHead((prev) => (prev.buyer.trim() === "" ? { ...prev, buyer } : prev));
      }),
    [],
  );

  useEffect(() => {
    if (mode.id === null) {
      freshDocNo(mode.kind, head.docDate);
    }
    // 只在新建单据且日期变化时取号
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind, mode.id]);

  /** 列表展示用：按编号/供应商/归属过滤，再按类型筛。 */
  const shownHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    return history.filter((v) => {
      if (historyKind !== "all" && v.kind !== historyKind) return false;
      if (!q) return true;
      return (
        v.docNo.toLowerCase().includes(q) ||
        (v.partner ?? "").toLowerCase().includes(q) ||
        (v.owner ?? "").toLowerCase().includes(q)
      );
    });
  }, [history, historyQuery, historyKind]);

  const shownAmount = useMemo(() => shownHistory.reduce((sum, v) => sum + v.amountCents, 0), [shownHistory]);

  const totals = useMemo(() => {
    let amount = 0;
    let qtySum = 0;
    let pieces = 0;
    for (const line of lines) {
      const q = Number(line.qty);
      const p = Number(line.price);
      if (Number.isFinite(q) && Number.isFinite(p)) amount += Math.round(q * p * 100);
      if (Number.isFinite(q)) qtySum += q;
      if (line.itemCode || line.itemName) pieces += 1;
    }
    return { amount, pieces, qty: qtySum };
  }, [lines]);

  const setLine = (key: string, patch: Partial<DraftLine>) => {
    dirty.current = true;
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  /**
   * 改表头：统一置脏。
   *
   * 之前只有 `setLine` 会置 dirty，改供应商/日期/单号/采购人/领用人都不置，
   * 于是「载入编辑」和「转单」看到 `dirty.current === false` 就直接覆盖，
   * 用户刚敲的单头一声不响没了。
   */
  const editHead = (patch: Partial<HeadDraft>) => {
    dirty.current = true;
    setHead((prev) => ({ ...prev, ...patch }));
  };

  /** 把当前录入内容拼成打印视图要的 Voucher 形状（不落库）。 */
  const printDraft = useMemo<Voucher>(() => {
    const draftLines = lines.map((line, index) => {
      const q = line.qty.trim() === "" ? null : Number(line.qty);
      const p = line.price.trim() === "" ? null : Math.round(Number(line.price) * 10_000);
      return {
        id: index + 1,
        ledgerId: index + 1,
        deliveryNo: line.deliveryNo.trim() || null,
        itemCode: line.itemCode.trim() || null,
        itemName: line.itemName.trim() || null,
        unit: line.unit.trim() || null,
        qty: q === null || !Number.isFinite(q) ? null : q,
        priceMicros: p === null || !Number.isFinite(p) ? null : p,
        amountCents: q === null || p === null ? null : Math.round((q * p) / 100),
        remark: line.remark.trim() || null,
        spec: line.spec?.trim() || null,
      };
    });
    return {
      id: mode.id ?? 0,
      kind: mode.kind,
      docNo: head.docNo,
      docDate: head.docDate,
      partner: mode.kind === "in" ? head.partner.trim() || null : head.owner.trim() || null,
      deliveryNo: null,
      buyer: head.buyer.trim() || null,
      owner: head.owner.trim() || null,
      receiver: head.receiver.trim() || null,
      remark: null,
      rowCount: draftLines.length,
      amountCents: draftLines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0),
      createdAt: "",
      sheet: `voucher:${mode.kind}`,
      lines: draftLines,
    };
  }, [lines, head, mode]);

  /** 选中物料编码：顺带带出名称、单位、最近单价。 */
  /** 从物料选择器选中一条：带出名称、单位、参考单价（出库不带单价）。 */
  const applyMaster = (key: string, item: Item) => {
    const patch: Partial<DraftLine> = {
      itemCode: item.itemCode,
      itemName: item.itemName,
      unit: item.unit ?? "",
      spec: item.spec ?? "",
    };
    if (mode.kind === "in" && item.priceMicros !== null && item.priceMicros !== undefined) {
      patch.price = String(item.priceMicros / 10_000);
    }
    setLine(key, patch);
  };

  const startNew = async (kind: Kind) => {
    clearVoucherDraft();
    setMode({ kind, id: null });
    setHead(blankHead(kind));
    setLines([blankLine()]);
    dirty.current = false;
    await freshDocNo(kind, today());
  };

  /** 点列表：只打开详情，不动左边正在录的单。 */
  const showVoucher = async (summary: VoucherSummary) => {
    setBusy(true);
    try {
      const voucher = await getVoucher(summary.id);
      if (!voucher) {
        toast("单据不存在", { status: "error" });
        return;
      }
      setViewingVoucher(voucher);
    } catch (err) {
      toast("单据读取失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  /** 显式「载入编辑」才把单据灌进表单；有未保存内容时先确认。 */
  const loadVoucherIntoForm = async (summary: VoucherSummary | Voucher) => {
    if (dirty.current && !window.confirm("左边有未保存的内容，载入这张单据会覆盖。继续？")) {
      return;
    }
    setBusy(true);
    try {
      const voucher = "lines" in summary ? summary : await getVoucher(summary.id);
      if (!voucher) {
        toast("单据不存在", { status: "error" });
        return;
      }
      setViewingVoucher(null);
      setMode({ kind: voucher.kind, id: voucher.id });
      setHead({
        docNo: voucher.docNo,
        docDate: voucher.docDate,
        partner: voucher.partner ?? "",
        buyer: voucher.buyer ?? "",
        owner: voucher.owner ?? "",
        receiver: voucher.receiver ?? "",
        storekeeper: "",
      });
      setLines(
        voucher.lines.length > 0
          ? voucher.lines.map((line) => {
              lineSeq += 1;
              return {
                key: `l${lineSeq}`,
                // 旧单据的送货单号存在单头，回填到每行
                deliveryNo: line.deliveryNo ?? voucher.deliveryNo ?? "",
                itemCode: line.itemCode ?? "",
                itemName: line.itemName ?? "",
                unit: line.unit ?? "",
                qty: line.qty === null ? "" : String(line.qty),
                // 单价按万分之一元存，厘级价（0.202）用两位小数回填会被截成 0.2，
                // 直接保存就把历史单价的精度改掉了。这里保留到 4 位。
                price: line.priceMicros === null ? "" : priceInput4(line.priceMicros),
                remark: line.remark ?? "",
                spec: line.spec ?? "",
              };
            })
          : [blankLine()],
      );
      dirty.current = false;
    } catch (err) {
      toast("单据读取失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 把弹窗里这张单抄成一张反向类型的新单（入库↔出库）载进左边表单：
   * 明细原样带过去，单据编号重新取号（不能沿用原单号），单头里
   * 供应商↔出库部门互换 —— 入库单的 partner 是供应商，出库单的 owner 是部门，语义不同。
   * 存单成功后才清空弹窗里的原单，不会动原单本身。
   */
  const convertVoucher = async (voucher: Voucher) => {
    const target: Kind = voucher.kind === "in" ? "out" : "in";
    const label = kindLabel(target);
    if (dirty.current && !window.confirm(`左边有未保存的内容，「转为${label}」会覆盖。继续？`)) {
      return;
    }
    const carried = voucher.lines.filter((line) => line.itemCode || line.itemName);
    if (carried.length === 0) {
      toast("这张单没有可转换的明细", { status: "error" });
      return;
    }
    setBusy(true);
    try {
      setViewingVoucher(null);
      setMode({ kind: target, id: null });
      setHead({
        docNo: "",
        docDate: today(),
        // 入库单的供应商 → 出库单只能落到出库部门；反过来出库部门不会当供应商带过去
        partner: target === "in" ? "" : (voucher.partner ?? ""),
        buyer: head.buyer,
        owner: target === "in" ? "" : (voucher.partner ?? voucher.owner ?? ""),
        receiver: voucher.receiver ?? "",
        storekeeper: "",
      });
      setLines(
        carried.map((line) => {
          lineSeq += 1;
          return {
            key: `l${lineSeq}`,
            deliveryNo: line.deliveryNo ?? voucher.deliveryNo ?? "",
            itemCode: line.itemCode ?? "",
            itemName: line.itemName ?? "",
            unit: line.unit ?? "",
            qty: line.qty === null ? "" : String(line.qty),
            // 出库单不记单价，转成入库单时留空让用户按当前进价填
            price: target === "in" && line.priceMicros !== null ? priceInput4(line.priceMicros) : "",
            remark: line.remark ?? "",
            spec: line.spec ?? "",
          };
        }),
      );
      dirty.current = false;
      await freshDocNo(target, today());
      toast(`已转为${label}，核对后保存`, { status: "success" });
    } catch (err) {
      toast("转换失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!isTauri) {
      toast("只读站不能开单", { description: "请在装有本程序的电脑上开单。", status: "error" });
      return;
    }
    // 先在前端挡掉明显的脏输入：数量是 NaN / Infinity / 0 / 负数，
    // 或单价不是有限数。否则这些值会以 null 落库，或让后端回一句
    // 「第 1 行数量不能为 0」，用户根本看不出是哪一栏打错了。
    const filled = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.itemCode.trim() || line.itemName.trim() || line.qty.trim());
    for (const { line, index } of filled) {
      const row = index + 1;
      const qtyRaw = line.qty.trim();
      if (qtyRaw === "") {
        toast(`第 ${row} 行没填数量`, { status: "error" });
        return;
      }
      const q = Number(qtyRaw.replace(/[,，]/g, ""));
      if (!Number.isFinite(q)) {
        toast(`第 ${row} 行数量不是数字`, { description: `填的是「${qtyRaw}」`, status: "error" });
        return;
      }
      if (q <= 0) {
        toast(`第 ${row} 行数量必须大于 0`, { description: `填的是 ${q}`, status: "error" });
        return;
      }
      if (mode.kind === "in" && line.price.trim() !== "") {
        const p = Number(line.price.replace(/[,，¥￥\s]/g, ""));
        if (!Number.isFinite(p) || p < 0) {
          toast(`第 ${row} 行单价不是有效数字`, { description: `填的是「${line.price}」`, status: "error" });
          return;
        }
      }
    }

    const payloadLines: VoucherLineInput[] = filled.map(({ line }) => {
      const p = Number(line.price.replace(/[,，¥￥\s]/g, ""));
      return {
        itemCode: line.itemCode.trim() || null,
        deliveryNo: line.deliveryNo.trim() || null,
        itemName: line.itemName.trim() || null,
        unit: line.unit.trim() || null,
        qty: Number(line.qty.replace(/[,，]/g, "")),
        priceMicros:
          mode.kind === "in" && Number.isFinite(p) && line.price.trim() !== "" ? Math.round(p * 10000) : null,
        remark: line.remark.trim() || null,
        spec: (line.spec ?? "").trim() || null,
      };
    });

    const payload = {
      kind: mode.kind,
      docNo: head.docNo.trim() || null,
      docDate: head.docDate,
      partner: mode.kind === "in" ? head.partner.trim() || null : null,
      buyer: mode.kind === "in" ? head.buyer.trim() || null : null,
      owner: mode.kind === "out" ? head.owner.trim() || null : null,
      receiver: mode.kind === "out" ? head.receiver.trim() || null : null,
      // 单头备注已去掉入口；备注按行填。这里固定 null，旧单据的备注仍在库里不回写。
      remark: null,
      lines: payloadLines,
    };

    setBusy(true);
    try {
      let savedId = mode.id;
      if (mode.id === null) {
        const id = await createVoucher(payload);
        savedId = id;
        toast("单据已保存", { description: `${head.docNo} · ${count(payloadLines.length)} 行`, status: "success" });
        setMode({ kind: mode.kind, id });
      } else {
        await updateVoucher(mode.id, payload);
        toast("单据已更新", { description: `${head.docNo} · ${count(payloadLines.length)} 行`, status: "success" });
      }
      dirty.current = false;
      clearVoucherDraft();
      // 下次新开单沿用这次填的采购人
      if (mode.kind === "in" && head.buyer.trim()) saveBuyer(head.buyer);
      // 手输的新供应商存进基础资料，下次输两个字就能关联出来
      if (mode.kind === "in" && head.partner.trim()) await rememberSupplier(head.partner);
      await loadHistory();

      // 保存成功立刻出稿：拿去签字归档是紧接着的下一步。
      // 新单刚建好，回读一次拿到带 id 的明细，打印内容和库里一致。
      //
      // 顺序很重要：先把打印视图挂出来，再 onChanged()。
      // onChanged 会让 App 回到「正在读取台账」那一屏，整个开单页被卸载重建，
      // 先跳出去的话 printingView 这个 state 会跟着一起丢掉，打印就永远不出来了。
      if (savedId !== null && printAfterSave) {
        try {
          const fresh = await getVoucher(savedId);
          if (fresh) setPrintingView(fresh);
          else setPrinting(true);
        } catch {
          // 回读失败就退回用当前草稿出稿，别让打印把保存流程卡住
          setPrinting(true);
        }
      }
      onChanged();
    } catch (err) {
      toast("保存失败", { description: String(err), status: "error", duration: 7000 });
    } finally {
      setBusy(false);
    }
  };

  const runDocSearch = useCallback(async (keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) {
      setDocHits(null);
      return;
    }
    setDocSearching(true);
    try {
      setDocHits(await searchDocs(trimmed, null, 50));
    } catch (err) {
      toast("查询失败", { description: String(err), status: "error" });
      setDocHits([]);
    } finally {
      setDocSearching(false);
    }
  }, []);

  /** 点查询结果：本机单也先看详情，导入单弹只读明细。 */
  const openHit = async (hit: DocHit) => {
    if (hit.voucherId !== null) {
      await showVoucher({
        id: hit.voucherId,
        kind: hit.kind,
        docNo: hit.docNo,
        docDate: hit.docDate ?? "",
        partner: hit.partner,
        owner: hit.owner,
        rowCount: hit.rowCount,
        amountCents: hit.amountCents,
        createdAt: "",
        firstItem: null,
      });
      return;
    }
    setBusy(true);
    try {
      const lines = await fetchDocLines(hit.docNo, hit.kind);
      setViewingImport({ hit, lines });
    } catch (err) {
      toast("明细读取失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      const removed = await deleteVoucher(pendingDelete.id);
      toast("单据已删除", { description: `${pendingDelete.docNo} · 同时删掉 ${count(removed)} 行明细` });
      setPendingDelete(null);
      if (mode.id === pendingDelete.id) await startNew(mode.kind);
      await loadHistory();
      onChanged();
    } catch (err) {
      toast("删除失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 手输了一个库里没有的供应商：存单成功后顺手写进基础资料，
   * 下次开单就能直接打前两个字关联出来。失败不影响已存好的单。
   */
  const rememberSupplier = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (suppliers.some((sup) => sup.name.trim().toLowerCase() === trimmed.toLowerCase())) return;
    try {
      await createSupplier({ name: trimmed, active: true });
      await loadSuppliers();
    } catch {
      // 与基础资料里已有（只是大小写/空格不同）的名称重复时后端会拒绝，此时不打扰用户
    }
  };

  const isIn = mode.kind === "in";

  // 供应商候选：按常用度（台账行数）排出常用名单，输入时再按「连号 > 按词 > 逐字」重排，
  // 这样打「亚德」「亚德客」都能落到「亚德客（中国）有限公司」。
  const supplierOptions = useMemo<PickerOption[]>(
    () => suppliers.map((sup) => ({ value: sup.name, hint: sup.hits > 0 ? `${sup.hits} 行` : undefined })),
    [suppliers],
  );
  const supplierHits = useMemo(() => {
    const map = new Map<string, number>();
    suppliers.forEach((sup) => map.set(sup.name, sup.hits));
    return map;
  }, [suppliers]);

  const rankSupplier = useCallback(
    (option: PickerOption, keyword: string) =>
      matchSupplier(option.value, keyword, supplierHits.get(option.value) ?? 0),
    [supplierHits],
  );

  return (
    <>
      <PageHeader
        title="开单"
        description="本机新开的入库单与出库单会和 Excel 导入的明细一起出现在台账里"
        actions={
          <>
            <Button
              size="small"
              variant={isIn ? "primary" : "secondary"}
              leadingIcon={RiFileAddLine}
              onClick={() => startNew("in")}
              disabled={busy}
            >
              新入库单
            </Button>
            <Button
              size="small"
              variant={isIn ? "secondary" : "primary"}
              leadingIcon={RiFileAddLine}
              onClick={() => startNew("out")}
              disabled={busy}
            >
              新出库单
            </Button>
            <Button
              size="small"
              variant="secondary"
              leadingIcon={showDocSearch ? RiSidebarFoldLine : RiSidebarUnfoldLine}
              aria-pressed={showDocSearch}
              title={showDocSearch ? "收起单据查询侧栏" : "展开单据查询侧栏"}
              onClick={() => {
                const next = !showDocSearch;
                setShowDocSearch(next);
                saveDocSearchOpen(next);
              }}
            >
              {showDocSearch ? "收起查询" : "单据查询"}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div
          className={
            showDocSearch ? "grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]" : "grid grid-cols-1 gap-4"
          }
        >
          {/* 单据主体：按纸单布局排 —— 居中标题、表头横带、明细、合计行、签字行 */}
          <section className="flex flex-col rounded-2xl border border-border-button-default bg-background-primary-default">
            {/* 单头：公司名 + 单据名（居中，和纸单一致） */}
            <div className="border-b border-separator-border px-6 py-4 text-center">
              <p className="text-caption-1-regular text-text-tertiary">温州乾力机械有限公司</p>
              <h2 className="mt-1 text-title-2-semibold tracking-wide text-text-primary">
                {isIn ? "入库单" : "出库单"}
              </h2>
              {mode.id !== null ? (
                <p className="mt-0.5 font-mono text-caption-1-regular tabular-nums text-text-tertiary">
                  编辑 #{mode.id}
                </p>
              ) : null}
            </div>

            {/* 第 3 行横带：供应商名称 → 输入 → 日期 → 单据编号（出库单换成归属） */}
            <div className="grid grid-cols-1 gap-3 border-b border-separator-border px-5 py-3 md:grid-cols-[auto_1fr_auto_auto]">
              {isIn ? (
                <span className="self-center text-body-2-medium text-text-secondary">供应商名称：</span>
              ) : (
                <span className="self-center text-body-2-medium text-text-secondary">出库部门：</span>
              )}
              <div className="flex items-center gap-1.5">
                <ComboPicker
                  ariaLabel={isIn ? "供应商" : "出库部门"}
                  value={isIn ? head.partner : head.owner}
                  onChange={(v) => editHead(isIn ? { partner: v } : { owner: v })}
                  options={isIn ? supplierOptions : ownerOptions.map((name) => ({ value: name }))}
                  rank={isIn ? rankSupplier : undefined}
                  autoCommitExact={isIn}
                  allowCustom
                  placeholder={isIn ? "输两个字关联供应商" : "选或输入部门"}
                  emptyText={isIn ? "没有匹配的供应商，直接回车按新名称保存" : "没有这个部门，直接输入即可"}
                />
                {isIn ? (
                  <Button
                    size="small"
                    variant="ghost"
                    leadingIcon={RiAddLine}
                    title="新增供应商"
                    aria-label="快速新增供应商"
                    onClick={() => setQuickAdd("supplier")}
                  >
                    新增
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">
                  {isIn ? "入库时间：" : "出库时间："}
                </span>
                <input
                  aria-label={isIn ? "入库时间" : "出库时间"}
                  value={head.docDate}
                  onChange={(e) => editHead({ docDate: e.target.value })}
                  onBlur={() => {
                    if (mode.id === null) freshDocNo(mode.kind, head.docDate);
                  }}
                  className="h-9 w-36 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 font-mono text-[0.8125rem] tabular-nums text-text-primary outline-none focus:border-border-focus-ring"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">单据编号：</span>
                <input
                  aria-label="单据编号"
                  value={head.docNo}
                  onChange={(e) => editHead({ docNo: e.target.value })}
                  className="h-9 w-36 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 font-mono text-[0.8125rem] tabular-nums text-text-primary outline-none focus:border-border-focus-ring"
                />
              </div>
            </div>

            {/* 明细表：列与纸单一致；送货单号逐行填（一张单可能对应多张送货单） */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] table-fixed border-collapse text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-separator-border bg-background-secondary-default text-caption-1-semibold text-text-tertiary">
                    <th className="w-10 px-2 py-2 text-center font-medium">#</th>
                    {isIn ? <th className="w-36 px-2 py-2 text-start font-medium">送货单号</th> : null}
                    <th className="w-32 whitespace-nowrap px-2 py-2 text-start font-medium">物料编码</th>
                    <th className="w-[18rem] min-w-[15rem] whitespace-nowrap px-2 py-2 text-start font-medium">
                      物料名称
                    </th>
                    <th className="w-20 whitespace-nowrap px-2 py-2 text-start font-medium">单位</th>
                    <th className="w-16 px-2 py-2 text-end font-medium">数量</th>
                    {isIn ? <th className="w-24 px-2 py-2 text-end font-medium">单价</th> : null}
                    {isIn ? <th className="w-28 px-2 py-2 text-end font-medium">合计</th> : null}
                    <th className="w-32 px-2 py-2 text-start font-medium">备注</th>
                    <th className="w-10 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => {
                    const amount =
                      Number.isFinite(Number(line.qty)) && Number.isFinite(Number(line.price)) && line.price !== ""
                        ? Number(line.qty) * Number(line.price)
                        : null;
                    return (
                      <tr key={line.key} className="border-b border-separator-border last:border-0">
                        <td className="px-2 py-1 text-center font-mono text-[0.6875rem] tabular-nums text-text-tertiary">
                          {index + 1}
                        </td>
                        {isIn ? (
                          <td className="px-1 py-1">
                            <input
                              aria-label={`第 ${index + 1} 行送货单号`}
                              value={line.deliveryNo}
                              onChange={(e) => setLine(line.key, { deliveryNo: e.target.value })}
                              placeholder="送货单号"
                              className="h-8 w-full rounded-md border border-border-button-default bg-background-secondary-default px-1.5 hover:border-border-button-hover focus:border-border-focus-ring focus:bg-background-primary-default font-mono text-[0.75rem] tabular-nums text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                            />
                          </td>
                        ) : null}
                        <td className="px-1 py-1">
                          <ItemPicker
                            value={line.itemCode}
                            onPick={(item) => applyMaster(line.key, item)}
                            onChangeText={(text) => setLine(line.key, { itemCode: text })}
                            // 出库只能领有库存的物料；入库才需要能选到没有结存的新料
                            inStockOnly={!isIn}
                            placeholder={isIn ? "编码或名称" : "选有库存的物料"}
                          />
                        </td>
                        <td className="px-1 py-1">
                          {/* 名称列同样引用基础资料：选中一条会一并带出编码、单位与最近单价 */}
                          <div className="group/name flex items-center gap-1.5">
                            <div className="min-w-0 flex-1">
                              <ItemPicker
                                value={line.itemName}
                                onPick={(item) => applyMaster(line.key, item)}
                                onChangeText={(text) => setLine(line.key, { itemName: text })}
                                inStockOnly={!isIn}
                                placeholder={isIn ? "选或输入名称" : "选有库存的物料"}
                              />
                            </div>
                            <SpecBadge
                              value={line.spec}
                              showAdd={Boolean(line.itemName && !line.spec)}
                              onChange={(v) => setLine(line.key, { spec: v })}
                            />
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          <ComboPicker
                            ariaLabel={`第 ${index + 1} 行单位`}
                            value={line.unit}
                            onChange={(v) => setLine(line.key, { unit: v })}
                            options={unitOptions.map((u) => ({ value: u }))}
                            allowCustom
                            compact
                            placeholder="单位"
                            emptyText="没有这个单位，直接回车新增"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            inputMode="decimal"
                            value={line.qty}
                            onChange={(e) => setLine(line.key, { qty: e.target.value })}
                            placeholder="0"
                            className="h-8 w-full rounded-md border border-border-button-default bg-background-secondary-default px-1.5 hover:border-border-button-hover focus:border-border-focus-ring focus:bg-background-primary-default text-end font-mono tabular-nums text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                          />
                        </td>
                        {isIn ? (
                          <td className="px-1 py-1">
                            <input
                              inputMode="decimal"
                              value={line.price}
                              onChange={(e) => setLine(line.key, { price: e.target.value })}
                              placeholder="0.00"
                              className="h-8 w-full rounded-md border border-border-button-default bg-background-secondary-default px-1.5 hover:border-border-button-hover focus:border-border-focus-ring focus:bg-background-primary-default text-end font-mono tabular-nums text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                            />
                          </td>
                        ) : null}
                        {isIn ? (
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-primary">
                            {amount === null ? "—" : money(Math.round(amount * 100))}
                          </td>
                        ) : null}
                        <td className="px-1 py-1">
                          <input
                            value={line.remark}
                            onChange={(e) => setLine(line.key, { remark: e.target.value })}
                            placeholder="备注"
                            className="h-8 w-full rounded-md border border-border-button-default bg-background-secondary-default px-1.5 hover:border-border-button-hover focus:border-border-focus-ring focus:bg-background-primary-default text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                          />
                        </td>
                        <td className="px-1 py-1 text-center">
                          <button
                            type="button"
                            aria-label={`删除第 ${index + 1} 行`}
                            onClick={() => {
                              dirty.current = true;
                              setLines((prev) =>
                                prev.length === 1 ? [blankLine()] : prev.filter((l) => l.key !== line.key),
                              );
                            }}
                            className="inline-flex size-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-destructive"
                          >
                            <RiDeleteBinLine className="size-4" aria-hidden />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {/* 合计行：与纸单一致，单独一行 */}
                  <tr className="border-t border-separator-border bg-background-secondary-default">
                    <td
                      colSpan={isIn ? 4 : 3}
                      className="px-2 py-2 text-end text-caption-1-semibold text-text-secondary"
                    >
                      合计
                      <span className="ms-2 font-normal text-caption-1-regular text-text-tertiary">
                        {count(totals.pieces)} 行有物料
                      </span>
                    </td>
                    <td />
                    <td className="px-2 py-2 text-end font-mono text-body-2-medium tabular-nums text-text-secondary">
                      {qty(totals.qty)}
                    </td>
                    {isIn ? <td /> : null}
                    {isIn ? (
                      <td className="px-2 py-2 text-end font-mono text-body-2-medium tabular-nums text-text-primary">
                        {money(totals.amount)}
                      </td>
                    ) : null}
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 签字行：采购人 / 仓管 / 领用人，照纸单放在最底 */}
            <div className="grid grid-cols-1 gap-3 border-t border-separator-border px-5 py-3 md:grid-cols-3">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">采购人：</span>
                <ComboPicker
                  ariaLabel="采购人"
                  value={head.buyer}
                  onChange={(v) => editHead({ buyer: v })}
                  options={buyerOptions.map((name) => ({ value: name }))}
                  allowCustom
                  placeholder="选或输入"
                  emptyText="没这个人，直接输入即可"
                  className="min-w-0 flex-1"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">仓管：</span>
                <input
                  aria-label="仓管"
                  value={head.storekeeper}
                  onChange={(e) => editHead({ storekeeper: e.target.value })}
                  placeholder="签字"
                  className="h-8 min-w-0 flex-1 rounded-md border border-border-button-default bg-background-secondary-default px-1.5 hover:border-border-button-hover focus:border-border-focus-ring focus:bg-background-primary-default text-body-regular text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-body-2-medium text-text-secondary">领用人：</span>
                <input
                  aria-label="领用人签字"
                  value={head.receiver}
                  onChange={(e) => editHead({ receiver: e.target.value })}
                  placeholder="签字"
                  className="h-8 min-w-0 flex-1 rounded-md border border-border-button-default bg-background-secondary-default px-1.5 hover:border-border-button-hover focus:border-border-focus-ring focus:bg-background-primary-default text-body-regular text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-default focus:border-border-focus-ring"
                />
              </div>
            </div>

            {/* 操作条 */}
            <div className="flex flex-wrap items-center gap-2 border-t border-separator-border px-5 py-3">
              <Button
                size="small"
                variant="secondary"
                leadingIcon={RiAddLine}
                onClick={() => {
                  dirty.current = true;
                  setLines((prev) => [...prev, blankLine()]);
                }}
              >
                加一行
              </Button>
              <Button
                size="small"
                variant="secondary"
                leadingIcon={RiAddLine}
                title="新增物料到基础资料，并填进一行明细"
                onClick={() => {
                  // 记住当前最后一行：新增完直接把新物料填进去，不用再去编码列选一遍
                  quickAddTargetLine.current = lines[lines.length - 1]?.key ?? null;
                  setQuickAdd("item");
                }}
                disabled={!isTauri}
              >
                新增物料
              </Button>
              <span className="text-caption-1-regular text-text-tertiary">
                选物料编码会自动带出名称、单位与最近单价
              </span>
              <div className="ms-auto flex items-center gap-2">
                {busy ? <Spinner size="xs" aria-label="保存中" /> : null}
                <label
                  className="flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-caption-1-regular text-text-tertiary hover:text-text-secondary"
                  title="勾上后，每次保存成功都会自动打开 A4 打印（Ctrl+S 保存同样生效）"
                >
                  <input
                    type="checkbox"
                    checked={printAfterSave}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setPrintAfterSave(next);
                      savePrintAfterSave(next);
                    }}
                    className="size-3.5 cursor-pointer accent-accent-500"
                  />
                  保存后打印
                </label>
                <Button size="small" variant="secondary" leadingIcon={RiPrinterLine} onClick={() => setPrinting(true)}>
                  A4 打印
                </Button>
                <Button size="small" leadingIcon={RiSaveLine} onClick={submit} disabled={busy || !isTauri}>
                  {mode.id === null ? "保存单据" : "保存修改"}
                </Button>
                {mode.id !== null ? (
                  <Button
                    size="small"
                    variant="secondary"
                    leadingIcon={RiDeleteBinLine}
                    onClick={() => {
                      // 正在编辑的这张单可能不在 history 里（只加载最近 50 张），
                      // 直接用表单里的单号与明细行数构造，不依赖列表
                      if (mode.id === null) return;
                      setPendingDelete({
                        id: mode.id,
                        docNo: head.docNo.trim(),
                        rowCount: lines.filter((line) => line.itemCode.trim() || line.itemName.trim()).length,
                      });
                    }}
                  >
                    删除单据
                  </Button>
                ) : null}
              </div>
            </div>
            {!isTauri ? (
              <p className="border-t border-separator-border px-5 py-2 text-caption-1-regular text-text-tertiary">
                只读站不能开单，请在桌面端操作。
              </p>
            ) : null}
          </section>

          {/* 单据查询：按编号查，跨本机开单与导入两种来源；可从页头收起 */}
          {showDocSearch ? (
            <section className="flex flex-col gap-2 rounded-2xl border border-border-button-default bg-background-primary-default p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-title-4-semibold text-text-primary">单据查询</h2>
                <span className="text-caption-1-regular text-text-tertiary">编号可只填片段</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={docQuery}
                  onChange={(e) => setDocQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runDocSearch(docQuery);
                  }}
                  placeholder="单据编号，如 20260831206 或 0831"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 font-mono text-[0.75rem] tabular-nums text-text-primary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
                />
                <Button
                  size="small"
                  leadingIcon={RiSearchLine}
                  onClick={() => runDocSearch(docQuery)}
                  disabled={docSearching || !isTauri}
                >
                  查询
                </Button>
              </div>
              {docSearching ? (
                <div className="flex items-center gap-2 py-2 text-caption-1-regular text-text-tertiary">
                  <Spinner size="xs" aria-label="查询中" /> 正在查
                </div>
              ) : docHits === null ? null : docHits.length === 0 ? (
                <p className="py-2 text-caption-1-regular text-text-tertiary">
                  没找到编号包含「{docQuery.trim()}」的单据
                </p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-0.5 overflow-auto">
                  {docHits.map((hit) => (
                    <li key={hit.source + hit.docNo + hit.kind}>
                      <button
                        type="button"
                        onClick={() => openHit(hit)}
                        className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-background-secondary-hover"
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className={
                              hit.kind === "in"
                                ? "rounded bg-emerald-500/12 px-1 py-0.5 text-[0.6875rem] font-medium text-emerald-500"
                                : "rounded bg-sky-500/12 px-1 py-0.5 text-[0.6875rem] font-medium text-sky-400"
                            }
                          >
                            {kindLabel(hit.kind)}
                          </span>
                          <span className="font-mono text-body-2-medium tabular-nums text-text-primary">
                            {hit.docNo}
                          </span>
                          {hit.source === "import" ? (
                            <span className="rounded bg-background-secondary-default px-1 py-0.5 text-[0.625rem] text-text-tertiary">
                              导入
                            </span>
                          ) : null}
                          <span className="ms-auto text-caption-1-regular text-text-tertiary">{date(hit.docDate)}</span>
                        </span>
                        <span className="flex items-center gap-2 text-caption-1-regular text-text-tertiary">
                          <span className="truncate">{hit.partner ?? hit.owner ?? "—"}</span>
                          <span className="ms-auto shrink-0 font-mono tabular-nums">
                            {count(hit.rowCount)} 行 · {money(hit.amountCents)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {/* 单据列表 */}
          <section className="flex flex-col rounded-2xl border border-border-button-default bg-background-primary-default">
            <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-4">
              <h2 className="text-title-4-semibold text-text-primary">本机开单</h2>
              <span className="text-caption-1-regular text-text-tertiary">
                {historyQuery || historyKind !== "all"
                  ? `筛选命中 ${count(shownHistory.length)} 张 / 已加载 ${count(history.length)} 张`
                  : `已加载 ${count(history.length)} 张`}
                {history.length >= HISTORY_CAP ? "（只保留最近 500 张）" : ""}
              </span>
              <div className="ms-auto flex items-center gap-2">
                <input
                  aria-label="筛选本机单据"
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder="编号 / 供应商"
                  className="h-7 w-36 rounded-lg border border-border-button-default bg-background-secondary-default px-2 text-[0.75rem] text-text-primary placeholder:text-text-tertiary outline-none hover:border-border-button-hover focus:border-border-focus-ring"
                />
                {(["all", "in", "out"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={historyKind === k}
                    onClick={() => setHistoryKind(k)}
                    className={
                      "h-7 rounded-md px-2 text-[0.6875rem] font-medium transition-colors " +
                      (historyKind === k
                        ? "bg-background-primary-default text-text-primary ring-1 ring-separator-border"
                        : "text-text-tertiary hover:text-text-secondary")
                    }
                  >
                    {k === "all" ? "全部" : kindLabel(k)}
                  </button>
                ))}
              </div>
            </div>
            <p className="px-4 pb-2 text-caption-1-regular text-text-tertiary">
              点一行看明细；要改内容用弹窗里的「载入编辑」，不会冲掉左边正在录的单。
            </p>
            {shownHistory.length === 0 ? (
              <div className="px-4 pb-8 pt-2">
                <EmptyState
                  icon={RiFileList3Line}
                  title={history.length === 0 ? "还没有开过单" : "没有符合条件的单据"}
                  description={
                    history.length === 0
                      ? "左边填一张入库单或出库单，保存后会出现在台账里。"
                      : `这里只在已加载的 ${count(history.length)} 张里筛。更早的单请用上方「单据查询」按编号查。`
                  }
                />
              </div>
            ) : (
              <ul className="max-h-[560px] overflow-auto px-2 pb-3">
                {shownHistory.map((voucher) => (
                  <li key={voucher.id}>
                    <button
                      type="button"
                      onClick={() => showVoucher(voucher)}
                      className={
                        "flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-start transition-colors hover:bg-background-secondary-hover " +
                        (mode.id === voucher.id ? "bg-background-secondary-default" : "")
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={
                            voucher.kind === "in"
                              ? "rounded bg-emerald-500/12 px-1 py-0.5 text-[0.6875rem] font-medium text-emerald-500"
                              : "rounded bg-sky-500/12 px-1 py-0.5 text-[0.6875rem] font-medium text-sky-400"
                          }
                        >
                          {kindLabel(voucher.kind)}
                        </span>
                        <span className="font-mono text-body-2-medium tabular-nums text-text-primary">
                          {voucher.docNo}
                        </span>
                        {mode.id === voucher.id ? (
                          <span className="rounded bg-accent-500/12 px-1 py-0.5 text-[0.625rem] font-medium text-accent-500">
                            编辑中
                          </span>
                        ) : null}
                        <span className="ms-auto text-caption-1-regular text-text-tertiary">
                          {date(voucher.docDate)}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-caption-1-regular text-text-tertiary">
                        {/* 供应商/归属为空时退回首行物料名，别让整行只剩一个「—」 */}
                        <span className="truncate" title={voucher.firstItem ?? ""}>
                          {voucher.partner ?? voucher.owner ?? voucher.firstItem ?? "未填供应商"}
                        </span>
                        {voucher.partner || voucher.owner ? (
                          <span className="shrink-0 truncate text-text-tertiary/70" title={voucher.firstItem ?? ""}>
                            {voucher.firstItem ?? ""}
                          </span>
                        ) : null}
                        <span className="ms-auto shrink-0 font-mono tabular-nums">
                          {count(voucher.rowCount)} 行 · {money(voucher.amountCents)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {shownHistory.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-separator-border px-4 py-2">
                <span className="text-caption-1-regular text-text-tertiary">
                  已加载范围内：入库 {count(shownHistory.filter((v) => v.kind === "in").length)} 张 · 出库{" "}
                  {count(shownHistory.filter((v) => v.kind === "out").length)} 张
                </span>
                <span className="ms-auto font-mono text-body-2-medium tabular-nums text-text-primary">
                  已加载合计 {money(shownAmount)}
                </span>
                {history.length >= historyLimit && historyLimit < HISTORY_CAP ? (
                  <Button
                    size="small"
                    variant="ghost"
                    leadingIcon={RiArrowDownLine}
                    onClick={() => setHistoryLimit((n) => Math.min(HISTORY_CAP, n + HISTORY_STEP))}
                  >
                    加载更早的 50 张
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>

      {viewingVoucher ? (
        <Modal isOpen onOpenChange={(open: boolean) => !open && setViewingVoucher(null)} size="xl">
          {({ close }) => (
            <>
              <ModalHeader
                title={`${kindLabel(viewingVoucher.kind)}单 ${viewingVoucher.docNo}`}
                description={`${date(viewingVoucher.docDate)} · ${count(viewingVoucher.lines.length)} 行 · ${money(
                  viewingVoucher.lines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0),
                )} · ${viewingVoucher.partner ?? viewingVoucher.owner ?? "—"}`}
              />
              <ModalBody>
                <div className="overflow-x-auto rounded-xl border border-separator-border">
                  <table className="w-full border-collapse text-[0.8125rem]">
                    <thead>
                      <tr className="border-b border-separator-border bg-background-tertiary-default text-caption-1-semibold text-text-tertiary">
                        <th className="w-12 px-2 py-2 text-center font-medium">#</th>
                        <th className="w-32 px-2 py-2 text-start font-medium">送货单号</th>
                        <th className="w-32 px-2 py-2 text-start font-medium">物料编码</th>
                        <th className="px-2 py-2 text-start font-medium">物料名称</th>
                        <th className="w-14 px-2 py-2 text-start font-medium">单位</th>
                        <th className="w-24 px-2 py-2 text-end font-medium">数量</th>
                        <th className="w-24 px-2 py-2 text-end font-medium">单价</th>
                        <th className="w-28 px-2 py-2 text-end font-medium">合计</th>
                        <th className="w-32 px-2 py-2 text-start font-medium">备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingVoucher.lines.map((line, index) => (
                        <tr key={line.id} className="border-b border-separator-border last:border-0">
                          <td className="px-2 py-1 text-center font-mono text-[0.75rem] tabular-nums text-text-tertiary">
                            {index + 1}
                          </td>
                          <td className="truncate px-2 py-1 font-mono text-[0.75rem] text-text-secondary">
                            {line.deliveryNo ?? "—"}
                          </td>
                          <td className="truncate px-2 py-1 font-mono text-[0.75rem] text-text-secondary">
                            {line.itemCode ?? "—"}
                          </td>
                          <td className="px-2 py-1 text-text-primary">
                            <div className="flex items-center gap-1.5 truncate">
                              <span className="truncate" title={line.itemName ?? ""}>
                                {line.itemName ?? "—"}
                              </span>
                              {line.spec ? (
                                <span
                                  className="shrink-0 rounded bg-background-secondary-hover px-1.5 py-0.5 font-mono text-[0.6875rem] text-text-secondary ring-1 ring-border-button-default"
                                  title={`规格型号: ${line.spec}`}
                                >
                                  {line.spec}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-2 py-1 text-text-tertiary">{line.unit ?? "—"}</td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-secondary">
                            {qty(line.qty)}
                          </td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-tertiary">
                            {line.priceMicros === null ? "—" : priceText(line.priceMicros)}
                          </td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-primary">
                            {line.amountCents === null ? "—" : amount(line.amountCents)}
                          </td>
                          <td className="truncate px-2 py-1 text-text-tertiary" title={line.remark ?? ""}>
                            {line.remark ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-caption-1-regular text-text-tertiary">
                  点「载入编辑」才会把这张单读进左边表单；直接关闭不会动你正在录的内容。
                </p>
              </ModalBody>
              <ModalFooter>
                <Button
                  size="small"
                  variant="ghost"
                  leadingIcon={RiDeleteBinLine}
                  onClick={() => {
                    // 直接用当前打开的单构造待删项，不回查 history
                    setPendingDelete({
                      id: viewingVoucher.id,
                      docNo: viewingVoucher.docNo,
                      rowCount: viewingVoucher.lines.length,
                    });
                    close();
                  }}
                >
                  删除
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  leadingIcon={RiPrinterLine}
                  onClick={() => {
                    setPrintingView(viewingVoucher);
                    close();
                  }}
                >
                  A4 打印
                </Button>
                <Button size="small" variant="secondary" onClick={close}>
                  关闭
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  leadingIcon={RiArrowLeftRightLine}
                  title={`把这单的明细抄成一张新的${kindLabel(viewingVoucher.kind === "in" ? "out" : "in")}；原单不受影响`}
                  onClick={() => {
                    close();
                    convertVoucher(viewingVoucher);
                  }}
                >
                  {viewingVoucher.kind === "in" ? "转出库单" : "转入库单"}
                </Button>
                <Button size="small" onClick={() => loadVoucherIntoForm(viewingVoucher)}>
                  载入编辑
                </Button>
              </ModalFooter>
            </>
          )}
        </Modal>
      ) : null}

      {printingView ? <PrintVoucher voucher={printingView} onClose={() => setPrintingView(null)} /> : null}

      {viewingImport ? (
        <Modal isOpen onOpenChange={(open: boolean) => !open && setViewingImport(null)} size="xl">
          {({ close }) => (
            <>
              <ModalHeader
                title={`${kindLabel(viewingImport.hit.kind)}单 ${viewingImport.hit.docNo}`}
                description={`${date(viewingImport.hit.docDate)} · ${count(viewingImport.lines.length)} 行 · ${
                  viewingImport.hit.partner ?? viewingImport.hit.owner ?? "—"
                } · 来自 Excel 导入，只读`}
              />
              <ModalBody>
                <div className="overflow-x-auto rounded-xl border border-separator-border">
                  <table className="w-full border-collapse text-[0.8125rem]">
                    <thead>
                      <tr className="border-b border-separator-border bg-background-tertiary-default text-caption-1-semibold text-text-tertiary">
                        <th className="w-12 px-2 py-2 text-center font-medium">源行</th>
                        <th className="w-32 px-2 py-2 text-start font-medium">物料编码</th>
                        <th className="px-2 py-2 text-start font-medium">物料名称</th>
                        <th className="w-14 px-2 py-2 text-start font-medium">单位</th>
                        <th className="w-24 px-2 py-2 text-end font-medium">数量</th>
                        <th className="w-24 px-2 py-2 text-end font-medium">单价</th>
                        <th className="w-28 px-2 py-2 text-end font-medium">合计</th>
                        <th className="w-24 px-2 py-2 text-start font-medium">提醒</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingImport.lines.map((line) => (
                        <tr key={line.id} className="border-b border-separator-border last:border-0">
                          <td className="px-2 py-1 text-center font-mono text-[0.6875rem] tabular-nums text-text-tertiary">
                            {line.rowNo}
                          </td>
                          <td className="truncate px-2 py-1 font-mono text-[0.75rem] text-text-secondary">
                            {line.itemCode ?? "—"}
                          </td>
                          <td className="px-2 py-1 text-text-primary">
                            <div className="flex items-center gap-1.5 truncate">
                              <span className="truncate" title={line.itemName ?? ""}>
                                {line.itemName ?? "—"}
                              </span>
                              {line.spec ? (
                                <span
                                  className="shrink-0 rounded bg-background-secondary-hover px-1.5 py-0.5 font-mono text-[0.6875rem] text-text-secondary ring-1 ring-border-button-default"
                                  title={`规格型号: ${line.spec}`}
                                >
                                  {line.spec}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-2 py-1 text-text-tertiary">{line.unit ?? "—"}</td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-secondary">
                            {qty(line.qty)}
                          </td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-tertiary">
                            {line.priceMicros === null ? "—" : priceText(line.priceMicros)}
                          </td>
                          <td className="px-2 py-1 text-end font-mono tabular-nums text-text-primary">
                            {line.amountCents === null ? "—" : amount(line.amountCents)}
                          </td>
                          <td className="px-2 py-1 text-[0.6875rem] leading-4 text-amber-500">
                            {line.flags.length > 0 ? line.flags.map(flagLabel).join(" ") : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button size="small" variant="secondary" onClick={close}>
                  关闭
                </Button>
              </ModalFooter>
            </>
          )}
        </Modal>
      ) : null}

      <AlertDialog
        title="删除这张单据"
        description={
          pendingDelete
            ? `将删除 ${pendingDelete.docNo} 及其 ${count(pendingDelete.rowCount)} 行明细。台账里对应的行也会一起消失。`
            : ""
        }
        confirmLabel="删除"
        onConfirm={confirmDelete}
        isOpen={pendingDelete !== null}
        onOpenChange={(open: boolean) => !open && setPendingDelete(null)}
        variant="danger"
      />

      {quickAdd ? (
        <QuickAddDialog
          kind={quickAdd}
          onClose={() => setQuickAdd(null)}
          onCreated={(record) => {
            if (record.supplier) {
              // 新供应商直接填进单头
              editHead({ partner: record.supplier!.name });
              void loadSuppliers();
              return;
            }
            if (record.item) {
              const item = record.item;
              const target = quickAddTargetLine.current;
              const row = target === null ? undefined : lines.find((line) => line.key === target);
              // 只有「还是空着」的那一行才直接填；已经填过内容就另起一行，绝不覆盖已录的数据
              const isBlank =
                row !== undefined &&
                !row.itemCode.trim() &&
                !row.itemName.trim() &&
                !row.qty.trim() &&
                !row.price.trim();
              if (isBlank) {
                applyMaster(row!.key, item);
              } else {
                const fresh = blankLine();
                dirty.current = true;
                const freshLine: DraftLine = {
                  ...fresh,
                  itemCode: item.itemCode,
                  itemName: item.itemName,
                  unit: item.unit ?? "",
                  spec: item.spec ?? "",
                };
                if (mode.kind === "in" && item.priceMicros !== null && item.priceMicros !== undefined) {
                  freshLine.price = String(item.priceMicros / 10_000);
                }
                setLines((prev) => [...prev, freshLine]);
              }
            }
          }}
        />
      ) : null}

      {printing ? <PrintVoucher voucher={printDraft} onClose={() => setPrinting(false)} /> : null}
    </>
  );
}

/**
 * 供应商模糊匹配打分。返回 0 表示不命中。
 *
 * 分层：连号名称（「亚德」对「亚德客…」）最硬，其次是按空格拆开的词逐个命中，
 * 最后才是散落字（「自」对「…中国…」）。同档内先看名称里命中的占比——
 * 越短的名字越「专一」——再看台账行数，免得常用大供应商把更贴切的短名压下去。
 */
function matchSupplier(name: string, rawKeyword: string, hits: number): number {
  const keyword = rawKeyword.trim().toLowerCase().replace(/\s+/g, " ");
  const hay = name.toLowerCase();
  if (!keyword) return 1;

  let tier: number;
  let gap = 0;
  if (hay.includes(keyword)) {
    tier = 60;
  } else {
    const words = keyword.split(" ").filter(Boolean);
    if (words.length > 1 && words.every((w) => hay.includes(w))) {
      tier = 45;
    } else {
      // 逐字顺序命中（允许跳字），「自」「亚德客中」都能走到这一层
      let cursor = 0;
      for (const ch of keyword.replace(/\s+/g, "")) {
        const at = hay.indexOf(ch, cursor);
        if (at < 0) return 0;
        gap += at - cursor;
        cursor = at + ch.length;
      }
      tier = gap <= 2 ? 25 : 20;
    }
  }

  const density = keyword.replace(/\s+/g, "").length / Math.max(hay.length, 1);
  // 前缀命中永远优先于同档的后缀命中
  const prefixBonus = hay.startsWith(keyword) ? 10 : 0;
  const hitsBonus = Math.min(hits, 500) / 100; // 最多 5 分，只用来打破同档平局
  return tier + prefixBonus + density * 10 + hitsBonus;
}
