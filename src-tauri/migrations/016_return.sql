-- 016: 退货单（退回供应商）
--
-- 语义：采购的料有问题或多余，退回给供应商。库存减少、金额计入「出库」，
-- 所以 `ledger.kind` 仍然是 `out`——这样 stock.rs / summary.rs / item_master
-- 里所有 `kind='out'` 的聚合口径天然就是对的，不必到处加分支。
--
-- 区分靠 `is_return`，再记一张来源单（本机开过的入库单），方便追溯与
-- 「已退 / 可退」校验：
--   · 退货单 `kind='out' AND is_return=1`
--   · 普通出库 `kind='out' AND is_return=0`
-- 单据编号单独前缀 `TH20260901001`，与出库单的 `20260901001` 不会撞。
--
-- 老数据全部默认 0，升级后行为与之前完全一致。

ALTER TABLE vouchers ADD COLUMN is_return         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vouchers ADD COLUMN source_voucher_id INTEGER;
ALTER TABLE vouchers ADD COLUMN source_doc_no     TEXT;

ALTER TABLE ledger   ADD COLUMN is_return         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger   ADD COLUMN source_voucher_id INTEGER;
ALTER TABLE ledger   ADD COLUMN source_doc_no     TEXT;

-- 台账按仓 + 类型筛退货，走仓库前缀
CREATE INDEX IF NOT EXISTS ix_ledger_wh_return  ON ledger (warehouse_id, is_return, doc_date DESC, id DESC);
-- 超退校验：按来源单 + 物料聚合已退数量
CREATE INDEX IF NOT EXISTS ix_ledger_return_src ON ledger (source_voucher_id, item_code);
CREATE INDEX IF NOT EXISTS ix_vouchers_wh_return ON vouchers (warehouse_id, is_return, doc_date DESC, id DESC);
