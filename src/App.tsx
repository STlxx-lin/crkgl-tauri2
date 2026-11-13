import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowDownSFill, RiArrowUpSFill, RiDatabase2Line, RiRefreshLine, RiServerLine } from "@remixicon/react";
import { cx } from "@/utils/cx";
import { bootstrap, fetchFacets, isTauri } from "./lib/api";
import type { BootstrapInfo } from "./lib/types";
import { count } from "./lib/format";
import { Button } from "@/components/base/buttons/button";
import { Spinner } from "@/components/base/spinner/spinner";
import { Toaster, toast } from "@/components/base/toast/toast";
import { AppShell, type PageKey } from "./components/AppShell";
import { LedgerScreen } from "./screens/LedgerScreen";
import { VoucherScreen } from "./screens/VoucherScreen";
import { MasterScreen } from "./screens/MasterScreen";
import { SummaryScreen } from "./screens/SummaryScreen";
import { StockScreen } from "./screens/StockScreen";
import { ImportScreen } from "./screens/ImportScreen";
import { RemoteScreen } from "./screens/RemoteScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

type Phase = "boot" | "ready" | "error";

export default function App() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [boot, setBoot] = useState<BootstrapInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 桌面端默认落在「开单」（导航第一项）；只读站没有开单，进台账
  const [page, setPage] = useState<PageKey>(() => (isTauri ? "voucher" : "ledger"));
  const [reloadKey, setReloadKey] = useState(0);
  const [ledgerRows, setLedgerRows] = useState(0);
  const [rangeFacets, setRangeFacets] = useState<{ minDate: string | null; maxDate: string | null }>({
    minDate: null,
    maxDate: null,
  });
  const loaded = useRef(false);

  const load = useCallback(async (silent = false) => {
    // silentRefresh：页面已经开着时只换数据，不进「正在读取台账」那一屏。
    // 进了那一屏 App 会 return 加载页，当前页面被卸载，页内 state（例如保存后弹的
    // 打印视图）会全部丢失。
    if (!silent) setPhase("boot");
    setError(null);
    try {
      if (isTauri) {
        const info = await bootstrap();
        setBoot(info);
        setPhase("ready");
        if (info.startupImport) {
          toast("已自动导入示例明细", {
            description: `${info.startupImport.fileName} · ${count(info.startupImport.rows)} 行`,
            duration: 6000,
          });
        }
      } else {
        // 80 端口只读站：没有 Tauri 桥，只展示台账与汇总
        const [facets] = await Promise.all([fetchFacets()]);
        setLedgerRows(facets.inRows + facets.outRows);
        setRangeFacets({ minDate: facets.minDate, maxDate: facets.maxDate });
        setBoot(null);
        setPhase("ready");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (loaded["current"]) return;
    loaded["current"] = true;
    load();
  }, [load]);

  const refreshBoot = useCallback(() => {
    setReloadKey((key) => key + 1);
    loaded["current"] = true;
    // 已经在用的时候静默刷新：数据会更新，但页面不重建
    void load(true);
  }, [load]);

  const nav = useMemo(() => {
    if (!isTauri) {
      // 只读站只给能看的页：开单、导入、只读站设置都需要桌面端
      return [
        { key: "ledger" as PageKey, label: "台账" },
        { key: "summary" as PageKey, label: "汇总" },
        { key: "stock" as PageKey, label: "库存" },
      ];
    }
    return undefined;
  }, []);

  if (phase === "boot") {
    return (
      <div className="flex h-full items-center justify-center bg-background-full">
        <div className="flex items-center gap-3 text-body-medium text-text-secondary">
          <Spinner size="sm" aria-label="正在读取数据" />
          正在读取台账
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background-full px-8">
        <RiDatabase2Line className="size-8 text-text-tertiary" aria-hidden />
        <p className="max-w-lg text-center text-body-medium text-text-primary">台账打不开</p>
        <p className="max-w-lg text-center text-body-2-regular text-text-tertiary">{error}</p>
        <Button size="small" leadingIcon={RiRefreshLine} onClick={refreshBoot}>
          重试
        </Button>
      </div>
    );
  }

  const rows = boot ? boot.rowCount : 0;
  const minDate = boot?.minDate ?? rangeFacets.minDate;
  const maxDate = boot?.maxDate ?? rangeFacets.maxDate;
  const dateRange = minDate && maxDate ? `${minDate} → ${maxDate}` : "—";

  return (
    <>
      <AppShell
        page={page}
        onPage={setPage}
        nav={nav}
        remote={!isTauri}
        footer={
          isTauri ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-caption-1-semibold text-text-tertiary">台账</span>
                <span className="font-mono text-body-2-medium tabular-nums text-text-primary">{count(rows)} 行</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-caption-1-semibold text-text-tertiary">日期</span>
                <span className="font-mono text-body-2-medium tabular-nums text-text-secondary">{dateRange}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-caption-1-semibold text-text-tertiary">只读站</span>
                <RemoteBadge web={boot?.web ?? null} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-body-2-regular text-text-secondary">
                <RiServerLine className="size-4" aria-hidden />
                只读访问
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-caption-1-semibold text-text-tertiary">台账</span>
                <span className="font-mono text-body-2-medium tabular-nums text-text-primary">{count(rows || ledgerRows)} 行</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-caption-1-semibold text-text-tertiary">日期</span>
                <span className="font-mono text-body-2-medium tabular-nums text-text-secondary">{dateRange}</span>
              </div>
            </div>
          )
        }
      >
        {/* 开单工作台保持常驻挂载：切换到其他页面查资料时，正在录入的内容、明细行和光标完整保留 */}
        {isTauri ? (
          <div className={cx("flex min-h-0 flex-1 flex-col", page !== "voucher" && "hidden")}>
            <VoucherScreen active={page === "voucher"} onChanged={refreshBoot} />
          </div>
        ) : null}

        {page === "ledger" ? (
          <LedgerScreen boot={boot} onChanged={refreshBoot} />
        ) : page === "master" ? (
          <MasterScreen onChanged={refreshBoot} />
        ) : page === "summary" ? (
          <SummaryScreen boot={boot} />
        ) : page === "stock" ? (
          <StockScreen onChanged={refreshBoot} />
        ) : page === "import" ? (
          <ImportScreen onImported={refreshBoot} />
        ) : page === "settings" ? (
          <SettingsScreen boot={boot} onChanged={refreshBoot} />
        ) : page === "remote" ? (
          <RemoteScreen boot={boot} onChanged={refreshBoot} />
        ) : null}
      </AppShell>
      <Toaster />
      <span className="hidden" data-reload-key={reloadKey} />
    </>
  );
}

function RemoteBadge({ web }: { web: BootstrapInfo["web"] | null }) {
  if (!web) {
    return <span className="text-body-2-regular text-text-tertiary">未启动</span>;
  }
  if (web.listening) {
    return (
      <span className="inline-flex items-center gap-1 text-body-2-medium text-text-primary">
        <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
        {web.port} 端口
        {web.port !== web.requestedPort ? <RiArrowDownSFill className="size-3" aria-hidden /> : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-body-2-regular text-text-tertiary" title={web.error ?? ""}>
      <span aria-hidden className="size-1.5 rounded-full bg-text-tertiary" />
      未监听
      <RiArrowUpSFill className="size-3 opacity-40" aria-hidden />
    </span>
  );
}
