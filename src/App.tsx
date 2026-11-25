import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowDownSFill, RiArrowUpSFill, RiDatabase2Line, RiRefreshLine, RiServerLine } from "@remixicon/react";
import { cx } from "@/utils/cx";
import { bootstrap, fetchFacets, fetchWarehouses, isTauri, listWarehouses } from "./lib/api";
import type { BootstrapInfo, Warehouse } from "./lib/types";
import { count } from "./lib/format";
import { Button } from "@/components/base/buttons/button";
import { Spinner } from "@/components/base/spinner/spinner";
import { Toaster, toast } from "@/components/base/toast/toast";
import { AppShell, type PageKey } from "./components/AppShell";
import { WarehousePicker, loadRemoteWarehouses, rememberRemoteWarehouse } from "./components/WarehousePicker";
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
  // 仓库：桌面端从 bootstrap 读，只读站从 /api/warehouses 读并记住自己的选择
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [activeWarehouseId, setActiveWarehouseId] = useState<number>(0);
  // 切换仓库后加一：给各页面当 key，强制重新挂载重新拉数
  const [warehouseEpoch, setWarehouseEpoch] = useState(0);
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
        setWarehouses(info.warehouses);
        setActiveWarehouseId(info.activeWarehouseId);
        setPhase("ready");
        if (info.startupImport) {
          toast("已自动导入示例明细", {
            description: `${info.startupImport.fileName} · ${count(info.startupImport.rows)} 行`,
            duration: 6000,
          });
        }
      } else {
        // 80 端口只读站：没有 Tauri 桥，只展示台账与汇总
        const remote = await loadRemoteWarehouses();
        setWarehouses(remote.warehouses);
        setActiveWarehouseId(remote.activeWarehouseId);
        const [facets] = await Promise.all([fetchFacets(true)]);
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

  /**
   * 切仓：桌面端让 Rust 写 settings，只读站只改本地选择。
   *
   * 各页面用 `warehouseEpoch` 重挂载；开单页是常驻挂载的（草稿要保住），
   * 所以单独给它一个 `warehouseId`，草稿按仓存。
   */
  const handleWarehouseChanged = useCallback(
    (id: number) => {
      // 先把 id 落进 state：开单页的草稿按仓取，晚一步就会先闪一下旧仓
      setActiveWarehouseId(id);
      setWarehouseEpoch((n) => n + 1);
      const name = warehouses.find((w) => w.id === id)?.name;
      if (name) {
        toast(`已切到「${name}」`, {
          description: "开单草稿按仓库分开保存，切回去接着录。",
          duration: 3500,
        });
      }
      if (!isTauri) {
        // 只读站：切仓后重新读本仓的候选与行数
        void (async () => {
          try {
            const facets = await fetchFacets(true);
            setLedgerRows(facets.inRows + facets.outRows);
            setRangeFacets({ minDate: facets.minDate, maxDate: facets.maxDate });
          } catch {
            setLedgerRows(0);
          }
          // 仓库列表里的行数也要跟着更新
          try {
            const info = await fetchWarehouses();
            setWarehouses(info.warehouses);
          } catch {
            // 忽略：下次刷新会重试
          }
        })();
        return;
      }
      refreshBoot();
    },
    [refreshBoot, warehouses],
  );

  // 仓库档案变更（新建/改名/停用/删除）：只重读仓库清单，不动当前页面
  const refreshWarehouses = useCallback(async () => {
    try {
      if (isTauri) {
        const list = await listWarehouses();
        setWarehouses(list);
        // 删掉的正好是当前仓库：后端已回落到另一个仓，这里跟着换过去
        if (list.length > 0 && !list.some((w) => w.id === activeWarehouseId)) {
          setWarehouseEpoch((n) => n + 1);
          refreshBoot();
        }
      } else {
        const info = await fetchWarehouses();
        setWarehouses(info.warehouses);
        // 自己在浏览器里选的仓被桌面端删了：跟回桌面端当前仓，别继续发无效 id
        if (info.warehouses.length > 0 && !info.warehouses.some((w) => w.id === activeWarehouseId)) {
          const fallback = info.activeWarehouseId;
          rememberRemoteWarehouse(fallback);
          setActiveWarehouseId(fallback);
          setWarehouseEpoch((n) => n + 1);
        }
      }
    } catch {
      // 忽略：下次 bootstrap 会带回最新清单
    }
  }, [activeWarehouseId, refreshBoot]);

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
  const activeWarehouse = warehouses.find((w) => w.id === activeWarehouseId) ?? null;

  return (
    <>
      <AppShell
        page={page}
        onPage={setPage}
        nav={nav}
        remote={!isTauri}
        top={
          warehouses.length > 0 && activeWarehouseId > 0 ? (
            <WarehousePicker
              warehouses={warehouses}
              activeId={activeWarehouseId}
              onSwitch={handleWarehouseChanged}
              onChanged={refreshWarehouses}
            />
          ) : null
        }
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
            <VoucherScreen
              active={page === "voucher"}
              warehouseId={activeWarehouseId}
              warehouseName={activeWarehouse?.name ?? null}
              onChanged={refreshBoot}
            />
          </div>
        ) : null}

        {/* 其余页面用 key 强制重挂载：切仓后所有分页、筛选、缓存都从新仓重新开始 */}
        {page === "ledger" ? (
          <LedgerScreen
            key={warehouseEpoch}
            boot={boot}
            warehouseName={activeWarehouse?.name ?? null}
            onChanged={refreshBoot}
          />
        ) : page === "master" ? (
          <MasterScreen onChanged={refreshBoot} />
        ) : page === "summary" ? (
          <SummaryScreen key={warehouseEpoch} boot={boot} />
        ) : page === "stock" ? (
          <StockScreen
            key={warehouseEpoch}
            warehouseName={activeWarehouse?.name ?? null}
            onChanged={refreshBoot}
          />
        ) : page === "import" ? (
          <ImportScreen key={warehouseEpoch} warehouseName={activeWarehouse?.name ?? null} onImported={refreshBoot} />
        ) : page === "settings" ? (
          <SettingsScreen
            key={warehouseEpoch}
            boot={boot}
            warehouse={activeWarehouse}
            warehouses={warehouses}
            onChanged={refreshBoot}
          />
        ) : page === "remote" ? (
          <RemoteScreen key={warehouseEpoch} boot={boot} onChanged={refreshBoot} />
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
