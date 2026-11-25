import type { ReactNode } from "react";
import {
  RiBarChart2Line,
  RiBookOpenLine,
  RiFileAddLine,
  RiFileList3Line,
  RiInbox2Line,
  RiServerLine,
  RiSettings3Line,
  RiUploadCloud2Line,
} from "@remixicon/react";
import { cx } from "@/utils/cx";
import { ThemeToggle } from "./ThemeToggle";
import { FontScaleToggle } from "./FontScaleToggle";

export type PageKey = "ledger" | "voucher" | "master" | "summary" | "stock" | "import" | "remote" | "settings";

interface NavItem {
  key: PageKey;
  label: string;
  icon: typeof RiFileList3Line;
  hint: string;
}

const ITEMS: NavItem[] = [
  // 开单放第一位：日常最常做的就是录一张单
  { key: "voucher", label: "开单", icon: RiFileAddLine, hint: "新入库/出库单" },
  { key: "ledger", label: "台账", icon: RiFileList3Line, hint: "入库与出库明细" },
  { key: "master", label: "基础资料", icon: RiBookOpenLine, hint: "物料与供应商" },
  { key: "summary", label: "汇总", icon: RiBarChart2Line, hint: "按月与按归属" },
  { key: "stock", label: "库存", icon: RiInbox2Line, hint: "结存与数据核对" },
  { key: "import", label: "导入", icon: RiUploadCloud2Line, hint: "从 Excel 读明细" },
  { key: "remote", label: "只读站", icon: RiServerLine, hint: "局域网的同事看账" },
  { key: "settings", label: "设置", icon: RiSettings3Line, hint: "打印与数据管理" },
];

interface AppShellProps {
  page: PageKey;
  onPage: (page: PageKey) => void;
  /** 只读站里只给能看的页 */
  nav?: { key: PageKey; label: string }[];
  remote: boolean;
  /** 侧栏标题下方的一块内容（仓库切换器） */
  top?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * 左侧导航 + 内容区。导航是应用里密度最高的地方：
 * 行高 32、图标一列、标签一行，选中态是一层浅表面加一条强调线，不做发光。
 */
export function AppShell({ page, onPage, nav, remote, top, footer, children }: AppShellProps) {
  const items = nav
    ? ITEMS.filter((item) => nav.some((entry) => entry.key === item.key))
    : ITEMS;

  return (
    <div className="flex h-full w-full overflow-hidden bg-background-full">
      <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-e border-separator-border bg-background-secondary-default">
        <div className="flex items-center gap-2 px-4 pb-2 pt-5">
          <LedgerMark />
          <div className="min-w-0">
            <p className="truncate text-body-medium text-text-primary">仓库出入库明细</p>
            <p className="truncate text-caption-1-regular text-text-tertiary">
              {remote ? "只读 · 局域网" : "本机 · 可导入"}
            </p>
          </div>
        </div>

        {top ? <div className="mt-3">{top}</div> : null}

        <nav className="mt-4 flex flex-col gap-0.5 px-2" aria-label="主导航">
          {items.map((item) => {
            const active = item.key === page;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onPage(item.key)}
                className={cx(
                  "group flex h-9 items-center gap-2.5 rounded-lg px-2 text-start outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                  active
                    ? "bg-background-primary-default text-text-primary shadow-xs ring-1 ring-separator-border"
                    : "text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
                )}
              >
                <Icon
                  className={cx("size-[18px] shrink-0", active ? "text-text-primary" : "text-foreground-icon-tertiary")}
                  aria-hidden
                />
                <span className="text-body-medium">{item.label}</span>
                <span className="ms-auto text-caption-1-regular text-text-tertiary">{item.hint}</span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-4 border-t border-separator-border px-4 py-4">
          {footer}
          <FontScaleToggle />
          <ThemeToggle className="self-start" />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}

/** 程序标记：一个货架格子，不用渐变也不用光晕。 */
function LedgerMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden className="shrink-0">
      <rect x="1.5" y="1.5" width="25" height="25" rx="6" fill="var(--color-background-primary-default)" stroke="var(--color-separator-border)" />
      <path d="M7 10h14M7 14.5h14M7 19h14" stroke="var(--color-text-tertiary)" strokeWidth="1.25" strokeLinecap="round" />
      <rect x="10" y="6.5" width="3" height="3" rx="0.75" fill="var(--color-text-primary)" />
      <rect x="10" y="12.5" width="3" height="3" rx="0.75" fill="var(--color-text-primary)" />
      <rect x="15.5" y="17" width="3" height="3" rx="0.75" fill="var(--color-text-primary)" />
    </svg>
  );
}

/** 页面头：标题 + 说明 + 右侧操作。 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-separator-border px-6 py-4">
      <div className="min-w-0">
        <h1 className="text-title-3-semibold text-text-primary">{title}</h1>
        {description ? (
          <p className="mt-1 text-body-2-regular text-text-tertiary">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="ms-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
