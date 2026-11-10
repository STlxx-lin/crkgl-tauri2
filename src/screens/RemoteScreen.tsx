import { useCallback, useEffect, useState } from "react";
import {
  RiExternalLinkLine,
  RiPlayCircleLine,
  RiPrinterLine,
  RiRefreshLine,
  RiServerLine,
  RiStopCircleLine,
} from "@remixicon/react";
import { accessLog, startWeb, stopWeb, webStatus } from "../lib/api";
import type { AccessEntry, BootstrapInfo, WebStatus } from "../lib/types";
import { count, shortTs } from "../lib/format";
import {
  PRINT_ROWS_DEFAULT,
  PRINT_ROWS_MAX,
  PRINT_ROWS_MIN,
  onPrintRowsChange,
  savePrintRows,
  storedPrintRows,
} from "../lib/printPrefs";
import { Button } from "@/components/base/buttons/button";
import { Spinner } from "@/components/base/spinner/spinner";
import { Switch } from "@/components/base/switch/switch";
import { toast } from "@/components/base/toast/toast";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/AppShell";

/**
 * 只读站页：开关、给同事的地址、访问记录。
 * 这里能改的只有"开/关"；写数据的入口在桌面端，不在这里。
 */
export function RemoteScreen({ boot, onChanged }: { boot: BootstrapInfo | null; onChanged: () => void }) {
  const [status, setStatus] = useState<WebStatus | null>(boot?.web ?? null);
  const [entries, setEntries] = useState<AccessEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [next, log] = await Promise.all([webStatus(), accessLog(100)]);
      setStatus(next);
      setEntries(log);
    } catch (err) {
      toast("状态读取失败", { description: String(err), status: "error" });
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (enabled) {
        const next = await startWeb();
        setStatus(next);
        if (next.listening) {
          toast("只读站已开启", { description: next.urls[0] ?? "" });
        } else {
          toast("没能监听端口", { description: next.error ?? "端口被占用", status: "error", duration: 8000 });
        }
      } else {
        await stopWeb();
        setStatus((prev) => (prev ? { ...prev, listening: false, enabled: false } : prev));
        toast("只读站已关闭");
      }
      onChanged();
      await refresh();
    } catch (err) {
      toast("操作失败", { description: String(err), status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const listening = status?.listening ?? false;

  return (
    <>
      <PageHeader
        title="只读站"
        description="本程序的 80 端口对局域网开放一份只读台账。导入、改行、删除只在这台电脑上做。"
        actions={
          <Button size="small" variant="secondary" leadingIcon={RiRefreshLine} onClick={refresh} disabled={busy}>
            刷新
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <section className="flex flex-col gap-4 rounded-2xl border border-border-button-default bg-background-primary-default p-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <RiServerLine className="size-[18px] text-text-secondary" aria-hidden />
                <h2 className="text-title-4-semibold text-text-primary">局域网只读</h2>
              </div>
              {busy ? (
                <Spinner size="sm" aria-label="处理中" />
              ) : (
                <Switch aria-label="开启局域网只读站" size="md" isSelected={listening} onChange={toggle} />
              )}
            </div>

            <dl className="flex flex-col gap-2 text-body-2-regular">
              <Row label="状态" value={listening ? `正在监听 ${status?.port} 端口` : status?.error ? "未监听（端口占用）" : "未开启"} />
              <Row label="端口" value={`${status?.port ?? 80}（请求 ${status?.requestedPort ?? 80}）`} />
              <Row label="只读页面" value={status?.staticReady ? "已随程序打包" : "缺少 dist-remote（开发时先 npm run build:remote）"} />
              <Row label="启动时间" value={status?.startedAt ?? "—"} />
            </dl>

            {status?.error && !listening ? (
              <p className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-caption-1-regular text-amber-500">
                {status.error}。用管理员身份运行本程序，或把占用 80 端口的程序关掉后再试。
              </p>
            ) : null}

            {listening ? (
              <div className="flex flex-col gap-2">
                <p className="text-caption-1-semibold text-text-tertiary">把这几个地址发给同事</p>
                {(status?.urls ?? []).map((url) => {
                  // 非 IP 形式的地址就是电脑名地址
                  const isHostName = !/\/\/(\d{1,3}\.){3}\d{1,3}:/.test(url);
                  return (
                    <div
                      key={url}
                      className="flex items-center gap-2 rounded-lg border border-separator-border bg-background-secondary-default px-3 py-2"
                    >
                      <code className="min-w-0 flex-1 truncate font-mono text-body-2-medium text-text-primary">{url}</code>
                      {isHostName ? (
                        <span
                          className="shrink-0 rounded bg-accent-500/12 px-1.5 py-0.5 text-caption-1-semibold text-accent-500"
                          title="用电脑名访问：同事那边只要和这台电脑在同一个局域网，且开启了网络发现就能用"
                        >
                          电脑名
                        </span>
                      ) : null}
                      <Button
                        size="small"
                        variant="ghost"
                        leadingIcon={RiExternalLinkLine}
                        onClick={() => {
                          void navigator.clipboard?.writeText(url);
                          toast("已复制地址", { description: url });
                        }}
                      >
                        复制
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-separator-border bg-background-secondary-default px-3 py-2">
                {listening ? (
                  <RiStopCircleLine className="mt-0.5 size-4 text-text-tertiary" aria-hidden />
                ) : (
                  <RiPlayCircleLine className="mt-0.5 size-4 text-text-tertiary" aria-hidden />
                )}
                <p className="text-caption-1-regular text-text-tertiary">
                  打开开关后，同一局域网的人用浏览器就能查台账、筛条件、导 CSV。他们看不到导入与删除按钮，接口层也没有写入口。
                </p>
              </div>
            )}

            <div className="mt-auto border-t border-separator-border pt-3">
              <p className="text-caption-1-semibold text-text-tertiary">安全边界</p>
              <ul className="mt-1 flex flex-col gap-1 text-caption-1-regular text-text-tertiary">
                <li>只接受局域网与回环地址，公网来源一律 403</li>
                <li>只注册 GET 接口；没有导入、修改、删除接口</li>
                <li>每 IP 每秒 30 次请求，超出返回 429</li>
                <li>禁止被其他站点用 iframe 嵌入</li>
              </ul>
            </div>
          </section>

          <PrintSetup />

          <section className="flex flex-col rounded-2xl border border-border-button-default bg-background-primary-default">
            <div className="flex items-baseline justify-between gap-2 px-5 pb-3 pt-4">
              <h2 className="text-title-4-semibold text-text-primary">访问记录</h2>
              <span className="text-caption-1-regular text-text-tertiary">最近 {count(entries.length)} 条 · 每 5 秒刷新</span>
            </div>
            {entries.length === 0 ? (
              <div className="px-5 pb-10 pt-2">
                <EmptyState title="还没有人访问" description="有人打开上面的地址后，这里会出现 IP 与请求路径。" />
              </div>
            ) : (
              <div className="max-h-[560px] overflow-auto">
                <table className="w-full table-fixed border-collapse text-[0.75rem]">
                  <thead className="sticky top-0 bg-background-primary-default">
                    <tr className="border-y border-separator-border text-caption-1-semibold text-text-tertiary">
                      <th className="w-[124px] whitespace-nowrap px-5 py-2 text-start font-medium">时间</th>
                      <th className="w-[132px] whitespace-nowrap px-3 py-2 text-start font-medium">来源</th>
                      <th className="px-3 py-2 text-start font-medium">请求</th>
                      <th className="w-24 whitespace-nowrap px-5 py-2 text-end font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, index) => (
                      <tr key={`${entry.at}-${entry.ip}-${index}`} className="border-b border-separator-border">
                        <td className="whitespace-nowrap px-5 py-1.5 font-mono tabular-nums text-text-tertiary">{shortTs(entry.at)}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-text-secondary">{entry.ip}</td>
                        <td className="truncate px-3 py-1.5 font-mono text-text-secondary">{entry.path}</td>
                        <td
                          className={
                            "whitespace-nowrap px-5 py-1.5 text-end font-mono tabular-nums " +
                            (entry.status >= 400 ? "text-amber-500" : "text-text-tertiary")
                          }
                        >
                          {entry.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-end text-text-secondary" title={value}>
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
        <h2 className="text-title-4-semibold text-text-primary">打印</h2>
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
