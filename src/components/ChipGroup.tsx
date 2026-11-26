/**
 * 单选胶囊组（全部 / 入库 / 出库 这类小范围互斥筛选）。
 *
 * 用 `radiogroup` + `radio` 而不是一排 toggle：语义上这里只能选一个，
 * 读屏会读成「单选组，当前第 N 项，共 M 项」。台账与开单记录两页共用。
 */
export function ChipGroup({
  items,
  value,
  onSelect,
  label,
}: {
  items: { id: string; label: string }[];
  value: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg bg-background-secondary-default p-0.5"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={value === item.id}
          onClick={() => onSelect(item.id)}
          className={
            "h-7 rounded-md px-2.5 text-caption-1-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring " +
            (value === item.id
              ? "bg-background-primary-default text-text-primary shadow-xs ring-1 ring-separator-border"
              : "text-text-tertiary hover:text-text-secondary")
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
