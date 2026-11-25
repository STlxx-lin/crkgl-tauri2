import { useEffect, useState } from "react";
import { RiComputerLine, RiDatabase2Line, RiDeleteBinLine, RiPrinterLine } from "@remixicon/react";
import { autostartSet, autostartStatus, clearData, isTauri } from "../lib/api";
import type { BootstrapInfo } from "../lib/types";
import { count } from "../lib/format";
import {
  PRINT_ROWS_DEFAULT,
  PRINT_ROWS_MAX,
  PRINT_ROWS_MIN,
  onPrintRowsChange,
  savePrintRows,
  storedPrintRows,
} from "../lib/printPrefs";
import { Button } from "@/components/base/buttons/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/base/modal/modal";
import { Spinner } from "@/components/base/spinner/spinner";
import { toast } from "@/components/base/toast/toast";
import { PageHeader } from "../components/AppShell";

/**
 * 设置页：打印设置 + 本机数据管理（清空数据）。
 */
export function SettingsScreen({ boot, onChanged }: { boot: BootstrapInfo | null; onChanged: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [includeMaster, setIncludeMaster] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      const out = await clearData(includeMaster);
      const parts = [
        `台账 ${count(out.ledgerRows)} 行`,
        `开单 ${count(out.vouchers)} 张`,
        `导入记录 ${count(out.imports)} 批`,
      ];
      if (includeMaster) {
        parts.push(`物料 ${count(out.items)} 条`, `供应商 ${count(out.suppliers)} 家`, `字典 ${count(out.dict)} 项`);
      }
      toast("数据已清空", {
        description: parts.join(" · "),
        status: "success",
        duration: 6000,
      });
      setConfirmOpen(false);
      setIncludeMaster(false);
      onChanged();
    } catch (err) {
      toast("清空数据失败", { description: String(err), status: "error" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <PageHeader title="设置" description="A4 打印排版偏好与本机数据库维护。" />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid max-w-4xl grid-cols-1 gap-4 md:grid-cols-2">
          <PrintSetup />
          <BackgroundSetup />

          <section className="flex flex-col gap-4 rounded-2xl border border-border-button-default bg-background-primary-default p-5">
            <div className="flex items-center gap-2">
              <RiDatabase2Line className="size-[18px] text-text-secondary" aria-hidden />
              <h2 className="text-title-4-semibold text-text-primary">本机数据管理</h2>
            </div>

            <dl className="flex flex-col gap-2 text-body-2-regular">
              <Row label="台账明细" value={`${count(boot?.rowCount ?? 0)} 行`} />
              <Row label="导入批次" value={`${count(boot?.importCount ?? 0)} 批`} />
              <Row label="数据库结构" value={`v${boot?.schemaVersion ?? 0} · 程序 v${boot?.appVersion ?? "—"}`} />
              <Row label="数据库文件" value={boot?.dbPath ?? "—"} />
            </dl>

            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/6 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-body-2-medium text-text-primary">清空数据</p>
                <p className="mt-0.5 text-caption-1-regular text-text-tertiary">
                  清空本机台账明细、开单与导入记录，可选一并清理基础资料。
                </p>
              </div>
              <Button
                size="small"
                variant="danger"
                leadingIcon={RiDeleteBinLine}
                disabled={!isTauri || clearing}
                onClick={() => {
                  setIncludeMaster(false);
                  setConfirmOpen(true);
                }}
              >
                清空数据
              </Button>
            </div>
          </section>
        </div>
      </div>

      {confirmOpen ? (
        <Modal
          isOpen
          onOpenChange={(open: boolean) => {
            if (!open && !clearing) setConfirmOpen(false);
          }}
          size="sm"
        >
          {({ close }) => (
            <>
              <ModalHeader
                title="确认清空本机数据？"
                description="清空后无法恢复，原 Excel 文件不受影响，之后可随时重新导入。"
              />
              <ModalBody>
                <div className="flex flex-col gap-3">
                  <div className="rounded-xl border border-separator-border bg-background-secondary-default px-3.5 py-2.5 text-body-2-regular text-text-secondary">
                    <p className="font-medium text-text-primary">默认将清空：</p>
                    <ul className="mt-1 list-inside list-disc text-caption-1-regular text-text-tertiary">
                      <li>全部出入库台账明细（共 {count(boot?.rowCount ?? 0)} 行）</li>
                      <li>本机新开的入库单 / 出库单</li>
                      <li>Excel 导入历史批次（共 {count(boot?.importCount ?? 0)} 批）</li>
                    </ul>
                  </div>

                  <label className="flex cursor-pointer select-none items-start gap-2.5 rounded-xl border border-border-button-default bg-background-primary-default px-3.5 py-2.5 hover:border-border-button-hover">
                    <input
                      type="checkbox"
                      checked={includeMaster}
                      onChange={(e) => setIncludeMaster(e.target.checked)}
                      disabled={clearing}
                      className="mt-0.5 size-4 cursor-pointer accent-red-500"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-body-2-medium text-text-primary">同时清空基础资料</span>
                      <span className="text-caption-1-regular text-text-tertiary">
                        一并删除所有物料主数据、加工件图号、供应商名录及常用词典（单位/类别/部门/采购人）。
                      </span>
                    </span>
                  </label>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button size="small" variant="secondary" onClick={close} disabled={clearing}>
                  取消
                </Button>
                <Button
                  size="small"
                  variant="danger"
                  leadingIcon={clearing ? undefined : RiDeleteBinLine}
                  onClick={handleClear}
                  disabled={clearing}
                >
                  {clearing ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Spinner size="xs" aria-label="清空中" />
                      正在清空…
                    </span>
                  ) : includeMaster ? (
                    "确认清空全部数据"
                  ) : (
                    "确认清空台账与开单"
                  )}
                </Button>
              </ModalFooter>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}

/**
 * 后台运行与开机自启。
 *
 * 关闭窗口不再退出程序：进程收进托盘，局域网只读站和后台资料照常工作；
 * 真正退出要点托盘的「退出」。开机自启打开后，登录 Windows 就会静悄悄拉起后台，
 * 不弹窗口，同事随时能打开只读站查账。
 */
function BackgroundSetup() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    autostartStatus()
      .then((on) => {
        if (alive) setEnabled(on);
      })
      .catch(() => {
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const real = await autostartSet(next);
      setEnabled(real);
      if (real === next) {
        toast(next ? "已开启开机自动启动" : "已关闭开机自动启动", {
          description: next ? "下次登录 Windows 会直接在后台运行，不弹窗口。" : "关闭不影响当前正在运行的后台。",
          status: "success",
        });
      } else {
        toast("开机自启没有生效", {
          description: "注册表写入被拦下了，检查组策略或安全软件后重试。",
          status: "error",
        });
      }
    } catch (err) {
      toast("设置失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const on = enabled === true;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default p-5">
      <div className="flex items-center gap-2">
        <RiComputerLine className="size-[18px] text-text-secondary" aria-hidden />
        <h2 className="text-title-4-semibold text-text-primary">后台运行</h2>
      </div>

      <label
        className={
          "flex cursor-pointer select-none items-start gap-2.5 rounded-xl border border-border-button-default px-3.5 py-3 hover:border-border-button-hover" +
          (!isTauri || busy ? " cursor-not-allowed opacity-60" : "")
        }
      >
        <input
          type="checkbox"
          role="switch"
          aria-label="开机自动启动并在后台运行"
          checked={on}
          disabled={!isTauri || busy || enabled === null}
          onChange={(e) => toggle(e.target.checked)}
          className="mt-0.5 size-4 cursor-pointer accent-accent-500 disabled:cursor-not-allowed"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-body-2-medium text-text-primary">
            开机自动启动，后台运行
            <span className="ms-1.5 inline-flex items-center rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-emerald-500">
              默认开启
            </span>
            {busy ? <span className="ms-2 text-caption-1-regular text-text-tertiary">正在写入…</span> : null}
          </span>
          <span className="text-caption-1-regular text-text-tertiary">
            登录 Windows 后在后台悄悄启动，不弹窗口；局域网只读站随即可用。要重新打开程序，双击托盘图标。
          </span>
        </span>
      </label>

      <p className="text-caption-1-regular text-text-tertiary">
        关闭窗口只是收进右下角托盘，程序继续在后台运行；彻底退出请右键托盘图标选「退出」。
        {isTauri ? null : " 浏览器里不能设置开机自启。"}
      </p>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-end font-mono text-[0.75rem] text-text-secondary" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * 打印设置：A4 打印视图每页预留几行明细。
 * 纸单固定 8 行；不够手写就调到 10/12，超出的部分自动分页。
 */
function PrintSetup() {
  const [rows, setRows] = useState(() => storedPrintRows());
  const [draft, setDraft] = useState(() => String(storedPrintRows()));

  useEffect(
    () =>
      onPrintRowsChange((next) => {
        setRows(next);
        setDraft(String(next));
      }),
    [],
  );

  const commit = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < PRINT_ROWS_MIN || n > PRINT_ROWS_MAX) {
      toast("行数超出范围", {
        description: `填 ${PRINT_ROWS_MIN}–${PRINT_ROWS_MAX} 之间的整数`,
        status: "error",
      });
      setDraft(String(rows));
      return;
    }
    if (n === rows) return;
    savePrintRows(n);
    setRows(n);
    toast("每页上限已更新", { description: `每页最多 ${n} 行`, status: "success" });
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default p-5">
      <div className="flex items-center gap-2">
        <RiPrinterLine className="size-[18px] text-text-secondary" aria-hidden />
        <h2 className="text-title-4-semibold text-text-primary">打印设置</h2>
      </div>
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-caption-1-semibold text-text-tertiary">A4 每页行数上限</span>
          <input
            aria-label="A4 每页行数上限"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            className="h-9 w-24 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 font-mono text-body-regular tabular-nums text-text-primary outline-none focus:border-border-focus-ring"
          />
        </label>
        <span className="pb-2 text-body-2-regular text-text-tertiary">
          默认 {PRINT_ROWS_DEFAULT}，可填 {PRINT_ROWS_MIN}–{PRINT_ROWS_MAX}
        </span>
      </div>
      <p className="text-caption-1-regular text-text-tertiary">
        打印按单据实际行数出稿：有几行打几行，不补空行；只有超过这个上限才分成多页。
      </p>
    </section>
  );
}
