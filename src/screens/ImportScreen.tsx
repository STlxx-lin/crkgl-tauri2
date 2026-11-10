import { useCallback, useEffect, useRef, useState } from "react";
import {
  RiArrowRightLine,
  RiBookOpenLine,
  RiCheckboxCircleLine,
  RiDeleteBinLine,
  RiFileExcel2Line,
  RiFolderOpenLine,
  RiRefreshLine,
  RiUploadCloud2Line,
} from "@remixicon/react";
import {
  deleteImport,
  importHistory,
  inspectWorkbook,
  isTauri,
  previewImport,
  runImport,
} from "../lib/api";
import type {
  ImportOutcome,
  ImportRecord,
  PreviewResult,
  SheetPlan,
  SheetReport,
  WorkbookReport,
} from "../lib/types";
import { count, date, fileSize, kindLabel } from "../lib/format";
import { Button } from "@/components/base/buttons/button";
import { Select, SelectItem } from "@/components/base/select/select";
import { Switch } from "@/components/base/switch/switch";
import { AlertDialog } from "@/components/base/modal/modal";
import { Spinner } from "@/components/base/spinner/spinner";
import { toast } from "@/components/base/toast/toast";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";

const FIELDS: { id: string; label: string }[] = [
  { id: "unused", label: "不导入" },
  { id: "doc_date", label: "日期" },
  { id: "doc_no", label: "单据编号" },
  { id: "delivery_no", label: "送货单号" },
  { id: "item_code", label: "物料编码" },
  { id: "item_name", label: "物料名称" },
  { id: "unit", label: "单位" },
  { id: "qty", label: "数量" },
  { id: "price", label: "单价" },
  { id: "amount", label: "合计金额" },
  { id: "remark", label: "备注" },
  { id: "partner", label: "供应商" },
  { id: "buyer", label: "采购人" },
  { id: "owner", label: "归属" },
  { id: "receiver", label: "领用人" },
];

type Step = "pick" | "map" | "done";

interface DraftPlan {
  name: string;
  enabled: boolean;
  mode: "append" | "replace";
  mapping: Record<string, string>;
}

/** 导入向导：选文件 → 认表头 → 预览校验 → 落库。 */
export function ImportScreen({ onImported }: { onImported: () => void }) {
  const [step, setStep] = useState<Step>("pick");
  const [report, setReport] = useState<WorkbookReport | null>(null);
  const [plans, setPlans] = useState<DraftPlan[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  // 主数据表：走 master 模块写基础资料，不参与列映射
  const masterSheets = report?.sheets.filter((sheet) => sheet.master) ?? [];
  // 单据模板、空表、库存结存这类，既不进台账也不进基础资料，只列名字说明为什么跳过
  const skippedSheets = report?.sheets.filter((sheet) => !sheet.master && !sheet.detail) ?? [];
  const [history, setHistory] = useState<ImportRecord[]>([]);
  const [pendingDelete, setPendingDelete] = useState<ImportRecord | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadHistory = useCallback(async () => {
    if (!isTauri) return;
    try {
      setHistory(await importHistory());
    } catch (err) {
      toast("导入历史读取失败", { description: String(err), status: "error" });
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const openFile = async () => {
    if (!isTauri) {
      toast("只读站不能导入", { description: "请在桌面端导入 Excel，局域网其他人看到的是同一份数据。", status: "error" });
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      directory: false,
      title: "选择出入库明细工作簿",
      filters: [{ name: "Excel 工作簿", extensions: ["xlsm", "xlsx"] }],
    });
    if (typeof picked === "string" && picked) inspect(picked);
  };

  const inspect = async (path: string) => {
    setBusy(true);
    setBusyLabel("正在读工作簿");
    setPreview(null);
    setOutcome(null);
    try {
      const result = await inspectWorkbook(path);
      const detailSheets = result.sheets.filter((sheet) => sheet.detail);
      if (detailSheets.length === 0) {
        setReport(result);
        setPlans([]);
        setStep("map");
        toast("没认出明细表", {
          description: "可以在下一步手动指定每列含义，或确认表里是否有日期、数量、物料列。",
          status: "error",
          duration: 8000,
        });
        return;
      }
      setReport(result);
      setPlans(detailSheets.map((sheet) => draftFromSheet(sheet)));
      setStep("map");
    } catch (err) {
      toast("打不开这个文件", { description: String(err), status: "error", duration: 8000 });
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  };

  const sheetPlans = useCallback((): SheetPlan[] => {
    return plans
      .filter((plan) => plan.enabled)
      .map((plan) => {
        const mapping: Record<string, string> = {};
        for (const [column, field] of Object.entries(plan.mapping)) {
          if (field && field !== "unused") mapping[column] = field;
        }
        return { name: plan.name, mapping, mode: plan.mode };
      });
  }, [plans]);

  const doPreview = async () => {
    if (!report) return;
    setBusy(true);
    setBusyLabel("正在核对每一行");
    try {
      const result = await previewImport(report.path, sheetPlans());
      setPreview(result);
    } catch (err) {
      toast("预览失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  };

  const doImport = async (replace: boolean) => {
    if (!report) return;
    setBusy(true);
    setBusyLabel("正在写入台账");
    try {
      const result = await runImport(report.path, sheetPlans(), replace);
      setOutcome(result);
      setStep("done");
      await loadHistory();
      onImported();
      toast("导入完成", {
        description: `${count(result.rows)} 行 · 跳过 ${count(result.skipped)} · 提醒 ${count(result.flagged)}`,
        status: "success",
      });
    } catch (err) {
      toast("导入失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  };

  const removeImport = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await deleteImport(pendingDelete.id);
      setPendingDelete(null);
      await loadHistory();
      onImported();
      toast("已删除这一批", { description: `${pendingDelete.fileName} · 清掉 ${count(pendingDelete.liveRows)} 行` });
    } catch (err) {
      toast("删除失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="导入"
        description="从 Excel 的入库明细 / 出库明细表读数据。原文件不改，只把行落进本机台账。"
        actions={
          step === "pick" ? (
            <Button size="small" leadingIcon={RiFolderOpenLine} onClick={openFile} disabled={busy || !isTauri}>
              选择文件
            </Button>
          ) : (
            <Button size="small" variant="secondary" onClick={() => setStep("pick")} disabled={busy}>
              换个文件
            </Button>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <ol className="mb-5 flex items-center gap-3 text-caption-1-semibold text-text-tertiary" aria-label="导入步骤">
          <StepDot index={1} label="选文件" active={step === "pick"} done={step !== "pick"} />
          <StepLine />
          <StepDot index={2} label="认列并预览" active={step === "map"} done={step === "done"} />
          <StepLine />
          <StepDot index={3} label="写入台账" active={step === "done"} done={false} />
        </ol>

        {busy ? (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-separator-border bg-background-secondary-default px-3 py-2 text-body-2-regular text-text-secondary">
            <Spinner size="xs" aria-label={busyLabel || "处理中"} />
            {busyLabel || "处理中"}
          </div>
        ) : null}

        {step === "pick" ? (
          <div className="flex flex-col gap-5">
            <button
              type="button"
              onClick={openFile}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                const file = event.dataTransfer.files[0];
                // WebView 里拿不到本地绝对路径，提示用按钮选
                if (file) {
                  toast("请点按钮选文件", {
                    description: "拖进来的文件没有本地路径，导入需要完整路径。",
                    duration: 5000,
                  });
                }
              }}
              className={
                "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring " +
                (dragOver
                  ? "border-accent-400 bg-background-secondary-hover"
                  : "border-border-button-default bg-background-primary-default hover:border-border-button-hover hover:bg-background-secondary-default")
              }
            >
              <span className="flex size-12 items-center justify-center rounded-2xl border border-separator-border bg-background-secondary-default">
                <RiUploadCloud2Line className="size-5 text-text-secondary" aria-hidden />
              </span>
              <span className="text-body-medium text-text-primary">选择一个 .xlsm / .xlsx 工作簿</span>
              <span className="max-w-md text-body-2-regular text-text-tertiary">
                首行表头会按内置别名自动对照：入库时间、单据编号、送货单号、物料编码、物料名称、单位、数量、单价、合计、供应商、采购人、归属、领用人。
                <span className="mt-1 block text-caption-1-regular text-text-tertiary">原文件只读，不修改 Excel。</span>
              </span>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsm,.xlsx"
                className="sr-only"
                onChange={() => {
                  toast("请点上面的按钮选文件", { description: "浏览器文件框拿不到本地路径。" });
                }}
              />
            </button>
            {!isTauri ? (
              <p className="text-body-2-regular text-text-tertiary">
                当前是只读站，不能在浏览器里导入。请在装有本程序的电脑上操作，导入后这里会同步看到。
              </p>
            ) : null}
          </div>
        ) : null}

        {step === "map" && report ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-separator-border bg-background-secondary-default px-4 py-3">
              <span className="inline-flex items-center gap-2 text-body-2-medium text-text-primary">
                <RiFileExcel2Line className="size-4 text-text-secondary" aria-hidden />
                {report.fileName}
              </span>
              <span className="font-mono text-caption-1-regular tabular-nums text-text-tertiary">{fileSize(report.sizeBytes)}</span>
              <span className="font-mono text-caption-1-regular tabular-nums text-text-tertiary">
                {report.sheets.length} 张表 · 认出 {report.sheets.filter((sheet) => sheet.detail).length} 张明细表
                {masterSheets.length > 0 ? ` · ${masterSheets.length} 张基础资料表` : ""}
              </span>
            </div>

            <div className="flex flex-col gap-3">
              {report.sheets.map((sheet) => {
                // 主数据表不做列映射，统一写进基础资料，下面单独列摘要
                if (sheet.master) return null;
                // 单据模板 / 空表这类不参与导入的，收成一行，别占整张卡片
                if (!sheet.detail) return null;
                const plan = plans.find((item) => item.name === sheet.name);
                return (
                  <SheetCard
                    key={sheet.name}
                    sheet={sheet}
                    plan={plan}
                    onChange={(next) =>
                      setPlans((prev) => {
                        const exists = prev.some((item) => item.name === next.name);
                        return exists ? prev.map((item) => (item.name === next.name ? next : item)) : [...prev, next];
                      })
                    }
                  />
                );
              })}
            </div>

            {skippedSheets.length > 0 ? (
              <p className="text-caption-1-regular text-text-tertiary">
                另外 {skippedSheets.length} 张表不导入：
                {skippedSheets.map((s) => `${s.name}（${s.note}）`).join("；")}
              </p>
            ) : null}

            {masterSheets.length > 0 ? (
              <div className="rounded-2xl border border-border-button-default bg-background-primary-default">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-separator-border px-4 py-3">
                  <RiBookOpenLine className="size-4 text-text-secondary" aria-hidden />
                  <span className="text-body-medium text-text-primary">基础资料</span>
                  <span className="text-caption-1-regular text-text-tertiary">
                    供应商、物料、图号和类型会写进「基础资料」，不进台账
                  </span>
                </div>
                <ul className="flex flex-col divide-y divide-separator-border">
                  {masterSheets.map((sheet) => (
                    <li key={sheet.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                      <span className="text-body-2-medium text-text-primary">{sheet.name}</span>
                      <span className="font-mono text-caption-1-regular tabular-nums text-text-tertiary">
                        {count(sheet.nonEmptyRows)} 行
                      </span>
                      <span className="text-caption-1-regular text-text-tertiary">{sheet.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="small" variant="secondary" leadingIcon={RiArrowRightLine} onClick={doPreview} disabled={busy || sheetPlans().length === 0}>
                预览并校验
              </Button>
              <span className="text-caption-1-regular text-text-tertiary">
                先核对前几行与问题清单，再决定写入。
              </span>
            </div>

            {preview ? (
              <PreviewPanel preview={preview} onImport={doImport} busy={busy} />
            ) : null}
          </div>
        ) : null}

        {step === "done" && outcome ? (
          <OutcomePanel outcome={outcome} onAgain={() => setStep("pick")} onNewFile={openFile} />
        ) : null}

        <section className="mt-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-title-4-semibold text-text-primary">导入历史</h2>
            <Button size="small" variant="ghost" leadingIcon={RiRefreshLine} onClick={loadHistory} disabled={busy}>
              刷新
            </Button>
          </div>
          {history.length === 0 ? (
            <div className="rounded-2xl border border-separator-border bg-background-primary-default px-5 py-10">
              <EmptyState title="还没有导入记录" description="第一次导入后会在这里留一条，可整批删除。" />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border-button-default bg-background-primary-default">
              <table className="w-full border-collapse text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-separator-border text-caption-1-semibold text-text-tertiary">
                    <th className="px-5 py-2.5 text-start font-medium">文件</th>
                    <th className="w-40 px-3 py-2.5 text-start font-medium">导入时间</th>
                    <th className="w-24 px-3 py-2.5 text-end font-medium">行数</th>
                    <th className="w-24 px-3 py-2.5 text-end font-medium">跳过</th>
                    <th className="w-24 px-3 py-2.5 text-end font-medium">现存</th>
                    <th className="w-28 px-5 py-2.5 text-end font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((record) => (
                    <tr key={record.id} className="border-b border-separator-border last:border-0">
                      <td className="max-w-[320px] truncate px-5 py-2.5 text-text-primary" title={`${record.fileName} · ${record.note ?? ""}`}>
                        {record.fileName}
                      </td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-text-tertiary">{record.importedAt}</td>
                      <td className="px-3 py-2.5 text-end font-mono tabular-nums text-text-secondary">{count(record.rowCount)}</td>
                      <td className="px-3 py-2.5 text-end font-mono tabular-nums text-text-tertiary">{count(record.skippedCount)}</td>
                      <td className="px-3 py-2.5 text-end font-mono tabular-nums text-text-primary">{count(record.liveRows)}</td>
                      <td className="px-5 py-2.5 text-end">
                        <Button
                          size="small"
                          variant="ghost"
                          leadingIcon={RiDeleteBinLine}
                          onClick={() => setPendingDelete(record)}
                          disabled={!isTauri || busy}
                        >
                          删除
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <AlertDialog
        title="删除这一批导入"
        description={
          pendingDelete
            ? `将删除 ${pendingDelete.fileName} 导入的 ${count(pendingDelete.liveRows)} 行。原 Excel 不会被改；已手工改过的行也会一起删掉。`
            : ""
        }
        confirmLabel="删除"
        onConfirm={removeImport}
        isOpen={pendingDelete !== null}
        onOpenChange={(open: boolean) => !open && setPendingDelete(null)}
      />
    </>
  );
}

function StepDot({ index, label, active, done }: { index: number; label: string; active: boolean; done: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={
          "flex size-5 items-center justify-center rounded-full border text-[0.6875rem] tabular-nums " +
          (active
            ? "border-text-primary bg-text-primary text-background-primary-default"
            : done
              ? "border-text-secondary text-text-secondary"
              : "border-separator-border text-text-tertiary")
        }
      >
        {done ? <RiCheckboxCircleLine className="size-4" /> : index}
      </span>
      <span className={active || done ? "text-text-primary" : undefined}>{label}</span>
    </li>
  );
}

function StepLine() {
  return <li aria-hidden className="h-px w-8 bg-separator-border" />;
}

function draftFromSheet(sheet: SheetReport): DraftPlan {
  const mapping: Record<string, string> = {};
  for (const header of sheet.headers) {
    mapping[String(header.column)] = header.field ?? "unused";
  }
  return { name: sheet.name, enabled: sheet.detail, mode: "replace", mapping };
}

function SheetCard({
  sheet,
  plan,
  onChange,
}: {
  sheet: SheetReport;
  plan: DraftPlan | undefined;
  onChange: (plan: DraftPlan) => void;
}) {
  const current = plan ?? draftFromSheet(sheet);
  const mapped = Object.values(current.mapping).filter((field) => field && field !== "unused");
  const isIn = sheet.name.includes("入库");
  const isOut = sheet.name.includes("出库") || sheet.name.includes("领用");

  return (
    <div className="rounded-2xl border border-border-button-default bg-background-primary-default">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-separator-border px-4 py-3">
        <Switch
          aria-label={`导入 ${sheet.name}`}
          size="sm"
          isSelected={current.enabled}
          onChange={(selected) => onChange({ ...current, enabled: selected })}
        />
        <span className="text-body-medium text-text-primary">{sheet.name}</span>
        {isIn ? (
          <span className="rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-caption-1-semibold text-emerald-500">入库</span>
        ) : isOut ? (
          <span className="rounded-md bg-sky-500/12 px-1.5 py-0.5 text-caption-1-semibold text-sky-400">出库</span>
        ) : (
          <span className="rounded-md bg-background-secondary-default px-1.5 py-0.5 text-caption-1-semibold text-text-tertiary">未定方向</span>
        )}
        <span className="font-mono text-caption-1-regular tabular-nums text-text-tertiary">
          {count(sheet.nonEmptyRows)} 行 · {sheet.note}
        </span>
        <div className="ms-auto flex items-center gap-2">
          <Select
            aria-label={`${sheet.name} 写入方式`}
            size="sm"
            selectedKey={current.mode}
            onSelectionChange={(key) => onChange({ ...current, mode: String(key) === "append" ? "append" : "replace" })}
            className="w-32"
          >
            <SelectItem id="replace">覆盖同名表</SelectItem>
            <SelectItem id="append">追加</SelectItem>
          </Select>
        </div>
      </div>

      {current.enabled ? (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {sheet.headers.map((header) => (
              <label
                key={header.column}
                className="flex flex-col gap-1 rounded-lg border border-separator-border bg-background-secondary-default px-2 py-1.5"
              >
                <span className="max-w-[140px] truncate text-caption-1-regular text-text-tertiary" title={header.header}>
                  {header.header}
                </span>
                <Select
                  aria-label={`${header.header} 对应字段`}
                  size="sm"
                  selectedKey={current.mapping[String(header.column)] ?? "unused"}
                  onSelectionChange={(key) =>
                    onChange({
                      ...current,
                      mapping: { ...current.mapping, [String(header.column)]: String(key) },
                    })
                  }
                  className="w-32"
                >
                  {FIELDS.map((field) => (
                    <SelectItem key={field.id} id={field.id}>
                      {field.label}
                    </SelectItem>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          {!mapped.includes("doc_date") || !mapped.includes("qty") || !(mapped.includes("item_name") || mapped.includes("item_code")) ? (
            <p className="text-caption-1-regular text-amber-500">
              至少要指定：日期、数量，以及物料编码或物料名称，否则这张表不能用。
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PreviewPanel({
  preview,
  onImport,
  busy,
}: {
  preview: PreviewResult;
  onImport: (replace: boolean) => Promise<void>;
  busy: boolean;
}) {
  const [replace, setReplace] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-title-4-semibold text-text-primary">核对结果</h2>
        <span className="font-mono text-body-2-medium tabular-nums text-text-secondary">{count(preview.totalRows)} 行可导入</span>
        <span className="font-mono text-body-2-regular tabular-nums text-text-tertiary">{count(preview.flaggedRows)} 行带提醒</span>
        <span className="font-mono text-body-2-regular tabular-nums text-text-tertiary">{count(preview.totalIssues)} 条问题</span>
      </div>

      {preview.sheets.map((sheet) => (
        <div key={sheet.name} className="rounded-xl border border-separator-border">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-separator-border px-3 py-2">
            <span className="text-body-2-medium text-text-primary">{sheet.name}</span>
            <span className="text-caption-1-semibold text-text-tertiary">{kindLabel(sheet.kind)}</span>
            <span className="font-mono text-caption-1-regular tabular-nums text-text-tertiary">
              {count(sheet.rows)} 行 · 跳过 {count(sheet.skipped)} · 提醒 {count(sheet.flagged)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.75rem]">
              <thead>
                <tr className="text-caption-1-semibold text-text-tertiary">
                  <th className="px-3 py-1.5 text-start font-medium">日期</th>
                  <th className="px-3 py-1.5 text-start font-medium">单据</th>
                  <th className="px-3 py-1.5 text-start font-medium">物料</th>
                  <th className="px-3 py-1.5 text-end font-medium">数量</th>
                  <th className="px-3 py-1.5 text-end font-medium">合计（元）</th>
                  <th className="px-3 py-1.5 text-start font-medium">提醒</th>
                </tr>
              </thead>
              <tbody>
                {sheet.sample.map((row) => (
                  <tr key={row.rowNo} className="border-t border-separator-border">
                    <td className="px-3 py-1.5 font-mono tabular-nums text-text-secondary">{date(row.docDate)}</td>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-text-tertiary">{row.docNo || "—"}</td>
                    <td className="max-w-[260px] truncate px-3 py-1.5 text-text-primary" title={row.itemName}>
                      {row.itemCode ? `${row.itemCode} ` : ""}
                      {row.itemName}
                    </td>
                    <td className="px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary">
                      {row.qty === null ? "—" : row.qty}
                    </td>
                    <td className="px-3 py-1.5 text-end font-mono tabular-nums text-text-secondary">
                      {row.amountCents === null ? "—" : (row.amountCents / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[0.6875rem] text-amber-500">{row.flags.join(" ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sheet.issues.length > 0 ? (
            <ul className="border-t border-separator-border px-3 py-2 text-caption-1-regular text-text-tertiary">
              {sheet.issues.slice(0, 5).map((issue) => (
                <li key={`${issue.rowNo}-${issue.message}`}>
                  第 {issue.rowNo} 行：{issue.message}
                </li>
              ))}
              {sheet.issues.length > 5 ? <li>…另有 {sheet.issues.length - 5} 条</li> : null}
            </ul>
          ) : null}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Switch size="sm" isSelected={replace} onChange={setReplace} aria-label="先清掉同名表的旧数据">
          先清掉同名表旧数据
        </Switch>
        <span className="text-caption-1-regular text-text-tertiary">
          不开这个开关时，新导入的行与已有行并存；重导同一个文件会产生重复行。
        </span>
        <Button size="small" className="ms-auto" onClick={() => onImport(replace)} disabled={busy || preview.totalRows === 0}>
          {busy ? "写入中" : `写入 ${count(preview.totalRows)} 行`}
        </Button>
      </div>
    </div>
  );
}

function OutcomePanel({
  outcome,
  onAgain,
  onNewFile,
}: {
  outcome: ImportOutcome;
  onAgain: () => void;
  onNewFile: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border-button-default bg-background-primary-default p-5">
      <div className="flex items-center gap-2">
        <RiCheckboxCircleLine className="size-5 text-emerald-500" aria-hidden />
        <h2 className="text-title-4-semibold text-text-primary">写入完成</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <OutcomeStat label="写入行数" value={count(outcome.rows)} />
        <OutcomeStat label="覆盖旧行" value={count(outcome.replaced)} />
        <OutcomeStat label="跳过" value={count(outcome.skipped)} />
        <OutcomeStat label="带提醒" value={count(outcome.flagged)} />
      </div>
      {outcome.duplicateOf ? (
        <p className="text-caption-1-regular text-amber-500">
          这个文件之前导入过（批次 #{outcome.duplicateOf}）。如果台账里出现重复行，删掉旧批次再导一次。
        </p>
      ) : null}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-body-2-regular text-text-secondary">
        {outcome.sheets.map((sheet) => (
          <li key={sheet.name}>
            {sheet.name} · {kindLabel(sheet.kind)} · {count(sheet.rows)} 行
          </li>
        ))}
      </ul>
      {outcome.master ? (
        <div className="rounded-xl border border-separator-border bg-background-secondary-default px-4 py-3">
          <p className="text-body-2-medium text-text-primary">
            基础资料：物料 +{count(outcome.master.itemsAdded)} / 更新 {count(outcome.master.itemsUpdated)}，供应商 +
            {count(outcome.master.suppliersAdded)}
          </p>
          <p className="mt-0.5 text-caption-1-regular text-text-tertiary">{outcome.master.message}</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption-1-regular text-text-tertiary">
            {outcome.master.sheetsFound.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {outcome.masterError ? (
        <p className="rounded-xl border border-separator-border bg-background-secondary-default px-4 py-3 text-caption-1-regular text-amber-500">
          基础资料没导进去：{outcome.masterError}
          <span className="block text-text-tertiary">台账的明细已经写好了，可以到「基础资料」页单独再导一次。</span>
        </p>
      ) : null}
      {outcome.issues.length > 0 ? (
        <div>
          <p className="text-caption-1-semibold text-text-tertiary">前 {Math.min(outcome.issues.length, 8)} 条问题</p>
          <ul className="mt-1 text-caption-1-regular text-text-tertiary">
            {outcome.issues.slice(0, 8).map((issue) => (
              <li key={`${issue.sheet}-${issue.rowNo}-${issue.message}`}>
                {issue.sheet} 第 {issue.rowNo} 行：{issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button size="small" variant="secondary" onClick={onAgain}>
          再导一次
        </Button>
        <Button size="small" variant="ghost" onClick={onNewFile}>
          换个文件
        </Button>
      </div>
    </div>
  );
}

function OutcomeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-separator-border px-3 py-2">
      <p className="text-caption-1-semibold text-text-tertiary">{label}</p>
      <p className="mt-0.5 font-mono text-title-4-semibold tabular-nums text-text-primary">{value}</p>
    </div>
  );
}
