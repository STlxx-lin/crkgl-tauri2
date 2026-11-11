-- 010: 库存计算与单价回查性能优化索引
--
-- 结存报表与开单物料联想均需要快速定位物料在入库单里的最近单价及结存变动。
-- 该复合覆盖索引直接覆盖 (item_code, kind, doc_date, id, price_micros)，
-- 避免在数千物料聚合时反复扫描 ledger 全表。

CREATE INDEX IF NOT EXISTS ix_ledger_stock_perf ON ledger (item_code, kind, doc_date DESC, id DESC, price_micros);
