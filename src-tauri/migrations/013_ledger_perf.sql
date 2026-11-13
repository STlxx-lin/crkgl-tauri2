-- 013: 台账加载与分页性能优化索引
--
-- 1) 复合覆盖索引：加速默认按日期倒序、按类型+日期倒序的分页查询，支持直接按索引有序扫描并消除全表扫描与临时 B-Tree 排序。
-- 2) 筛选项索引：加速 buyer、partner 字段的去重与过滤。

CREATE INDEX IF NOT EXISTS ix_ledger_date_id ON ledger (doc_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_ledger_kind_date_id ON ledger (kind, doc_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_ledger_buyer ON ledger (buyer);
CREATE INDEX IF NOT EXISTS ix_ledger_partner ON ledger (partner);
