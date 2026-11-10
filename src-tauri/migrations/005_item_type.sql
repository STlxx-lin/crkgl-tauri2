-- 005: 合并工作簿「基础信息」表。
--
-- 基础信息有 934 行（外购件 674 / 加工件 260），是旧的物料单价表。
-- 与「物料编号」重叠仅 333，另有 558 个名称只在基础信息里，
-- 其中 127 个在台账里实际用到 —— 这批不能丢。
--
-- 新增两个字段：
--   item_type  外购件 / 加工件（原来完全缺失的分类维度）
--   drawing_no 图号（基础信息的「图号」列，物料编号表没有）

ALTER TABLE items ADD COLUMN item_type TEXT;
ALTER TABLE items ADD COLUMN drawing_no TEXT;

CREATE INDEX IF NOT EXISTS ix_items_type ON items (item_type);
