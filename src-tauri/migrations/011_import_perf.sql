-- 011: 导入批次外键索引优化
-- 加速按 import_id 过滤、级联删除与导入后关联操作
CREATE INDEX IF NOT EXISTS ix_ledger_import_id ON ledger (import_id);
