import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { RiCloseLine, RiPrinterLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { amount, date, priceText, qty } from "../lib/format";
import { onPrintRowsChange, storedPrintRows } from "../lib/printPrefs";
import type { Voucher } from "../lib/types";
import "../styles/print.css";

/**
 * A4 打印视图。
 *
 * 一张单据按纸单排版：公司名 + 单据名居中、单据头两列、明细表、合计、三处签字。
 * 每页固定「打印行数」条明细（默认 8），不够补空行、超了自动分页，方便手写补记。
 * 用画面上的一张张白纸做预览，`window.print()` 时只输出这些纸。
 */
export function PrintVoucher({
  voucher,
  warehouseName,
  onClose,
  onRowsChange,
}: {
  voucher: Voucher;
  /** 仓库名：打在纸面上，多仓台账归档时不会混 */
  warehouseName?: string | null;
  onClose: () => void;
  onRowsChange?: (rows: number) => void;
}) {
  const [perPage, setPerPage] = useState(() => storedPrintRows());

  useEffect(() => onPrintRowsChange(setPerPage), []);

  useEffect(() => {
    onRowsChange?.(perPage);
  }, [perPage, onRowsChange]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isIn = voucher.kind === "in";
  const pages = useMemo(() => paginate(voucher.lines, perPage), [voucher.lines, perPage]);
  const totalAmount = voucher.lines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0);
  const totalQty = voucher.lines.reduce((sum, line) => sum + (line.qty ?? 0), 0);

  /**
   * 打开系统打印对话框，回来后自动收掉预览。
   *
   * `window.print()` 在同一次调用里是阻塞的：用户点了「打印」或「取消」并返回程序，
   * 它才继续往下走，所以函数返回就代表这一轮打印结束了。
   * 这里先让出一帧，把「正在打印」的按钮状态画出来，再调 print()。
   */
  const [printing, setPrinting] = useState(false);
  const handlePrint = () => {
    setPrinting(true);
    // 两帧：一帧把按钮置为禁用，一帧等绘制完成，避免对话框盖住之前界面还没更新
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          window.print();
        } finally {
          setPrinting(false);
          onClose();
        }
      }),
    );
  };

  // 挂到 body 上：AppShell 的滚动容器会裁剪高度，打印时三张纸会被压成一页
  return createPortal(
    <div className="print-overlay" role="dialog" aria-modal aria-label="A4 打印视图">
      <div className="mb-4 flex items-center justify-center gap-2 print:hidden">
        <Button size="small" leadingIcon={RiPrinterLine} onClick={handlePrint} disabled={printing}>
          {printing ? "正在打印…" : "打印"}
        </Button>
        <span className="rounded-lg bg-background-primary-default px-3 py-1.5 text-body-2-regular text-text-secondary">
          {voucher.lines.length} 行明细 · 共 {pages.length} 页 · 每页最多 {perPage} 行
        </span>
        <Button size="small" variant="secondary" leadingIcon={RiCloseLine} onClick={onClose}>
          关闭
        </Button>
      </div>

      {pages.map((chunk, pageIndex) => (
        <div key={pageIndex} className="print-paper">
          <div className="print-root print-sheet">            <div className="print-head">
              <div className="print-company">
                温州乾力机械有限公司
                {warehouseName ? ` · ${warehouseName}` : ""}
              </div>
              <h1 className="print-title">{isIn ? "入库单" : "出库单"}</h1>
            </div>

            <div className="print-meta">
              <div className="print-meta-row">
                <span className="print-meta-label">{isIn ? "供应商名称" : "归属"}：</span>
                <span className="print-meta-value">
                  {(isIn ? voucher.partner : (voucher.owner ?? voucher.partner)) ?? ""}
                </span>
              </div>
              <div className="print-meta-row">
                <span className="print-meta-label">单据编号：</span>
                <span className="print-meta-value">{voucher.docNo}</span>
              </div>
              {isIn ? (
                <div className="print-meta-row">
                  <span className="print-meta-label">送货单号：</span>
                  <span className="print-meta-value">
                    {uniqueDeliveryNos(voucher).join("、")}
                  </span>
                </div>
              ) : (
                <div aria-hidden />
              )}
              <div className="print-meta-row">
                <span className="print-meta-label">{isIn ? "入库时间" : "出库时间"}：</span>
                <span className="print-meta-value">{date(voucher.docDate)}</span>
              </div>
            </div>

            <table className="print-table">
              {isIn ? (
                <colgroup>
                  <col style={{ width: "5%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "6%" }} />
                  <col style={{ width: "9%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "13%" }} />
                </colgroup>
              ) : (
                <colgroup>
                  <col style={{ width: "5%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "21%" }} />
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "16%" }} />
                </colgroup>
              )}
              <thead>
                <tr>
                  <th>序号</th>
                  {isIn ? <th>送货单号</th> : null}
                  <th>物料编码</th>
                  <th>物料名称</th>
                  <th>单位</th>
                  <th>数量</th>
                  <th>单价</th>
                  <th>金额（元）</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {chunk.map((line, index) => (
                  <tr key={`${pageIndex}-${line.id}`}>
                    <td className="print-center">{pageIndex * perPage + index + 1}</td>
                    {isIn ? <td>{line.deliveryNo ?? ""}</td> : null}
                    <td>{line.itemCode ?? ""}</td>
                    <td>{line.itemName ?? ""}</td>
                    <td className="print-center">{line.unit ?? ""}</td>
                    <td className="print-num">{line.qty === null ? "" : qty(line.qty)}</td>
                    <td className="print-num">{line.priceMicros === null ? "" : priceText(line.priceMicros)}</td>
                    <td className="print-num">{line.amountCents === null ? "" : amount(line.amountCents)}</td>
                    <td>{line.remark ?? ""}</td>
                  </tr>
                ))}
                {/* 有几行打几行，不补空行；perPage 只是一页装得下的上限 */}
                {chunk.length === 0 ? (
                  <tr aria-hidden>
                    <td className="print-center">1</td>
                    <td colSpan={isIn ? 8 : 7}>&nbsp;</td>
                  </tr>
                ) : null}
                {pageIndex === pages.length - 1 ? (
                  <tr className="print-total">
                    <td colSpan={isIn ? 5 : 4} className="print-num">
                      合计
                    </td>
                    <td className="print-num">{qty(totalQty)}</td>
                    <td />
                    <td className="print-num">{amount(totalAmount)}</td>
                    <td />
                  </tr>
                ) : null}
              </tbody>
            </table>

            <div className="print-sign">
              <div>
                采购人：<span>{voucher.buyer || "\u00a0"}</span>
              </div>
              <div>
                仓管：<span>&nbsp;</span>
              </div>
              <div>
                领用人：<span>{voucher.receiver || "\u00a0"}</span>
              </div>
            </div>

            <div className="print-footnote">
              第 {pageIndex + 1} / {pages.length} 页
            </div>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** 按每页行数切页；行数为 0 时也给一页（表头+空行）。 */
function paginate<T>(lines: T[], perPage: number): T[][] {
  if (lines.length === 0) return [[]];
  const pages: T[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages;
}

/** 单头要显示这张单涉及的全部送货单号（跨行去重）。 */
function uniqueDeliveryNos(voucher: Voucher): string[] {
  const seen = new Set<string>();
  for (const line of voucher.lines) {
    const value = line.deliveryNo?.trim();
    if (value) seen.add(value);
  }
  if (seen.size === 0 && voucher.deliveryNo) seen.add(voucher.deliveryNo);
  return Array.from(seen);
}
