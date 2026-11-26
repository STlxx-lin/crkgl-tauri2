import { amount, priceText, qty } from "../lib/format";
import type { VoucherLine } from "../lib/types";

/**
 * 单据明细表（只读展示）。
 *
 * 开单页的详情弹窗与「开单记录」页看同一张单，列必须一致：
 * 送货单号、物料编码、名称 + 规格徽标、单位、数量、单价、合计、备注。
 * 抽成组件避免两处 JSX 各改一遍后开始漂移。
 */
export function VoucherLinesTable({
  lines,
  /** 送货单号列：出库单没有送货单号，隐藏整列省宽度 */
  showDeliveryNo = true,
  emptyText = "这张单没有明细",
}: {
  lines: VoucherLine[];
  showDeliveryNo?: boolean;
  emptyText?: string;
}) {
  if (lines.length === 0) {
    return (
      <p className="rounded-xl border border-separator-border px-4 py-8 text-center text-body-2-regular text-text-tertiary">
        {emptyText}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-separator-border">
      <table className="w-full border-collapse text-[0.8125rem]">
        <thead>
          <tr className="border-b border-separator-border bg-background-tertiary-default text-caption-1-semibold text-text-tertiary">
            <th className="w-12 px-2 py-2 text-center font-medium">#</th>
            {showDeliveryNo ? <th className="w-32 px-2 py-2 text-start font-medium">送货单号</th> : null}
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
          {lines.map((line, index) => (
            <tr key={line.id} className="border-b border-separator-border last:border-0">
              <td className="px-2 py-1 text-center font-mono text-[0.75rem] tabular-nums text-text-tertiary">
                {index + 1}
              </td>
              {showDeliveryNo ? (
                <td className="truncate px-2 py-1 font-mono text-[0.75rem] text-text-secondary">
                  {line.deliveryNo ?? "—"}
                </td>
              ) : null}
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
              <td className="px-2 py-1 text-end font-mono tabular-nums text-text-secondary">{qty(line.qty)}</td>
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
  );
}
