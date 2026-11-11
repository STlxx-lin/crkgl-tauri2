-- 008: 物料加「库位」。
--
-- 月度进销存宽表（仓库进销存-外购件.xlsx）每个物料都带库位，如 D-01-02-4F。
-- 这是实物找货用的字段，基础资料页和开单联动都要能看到，所以单独存一列，
-- 不再塞进 remark 或 spec。

ALTER TABLE items ADD COLUMN location TEXT;

CREATE INDEX IF NOT EXISTS ix_items_location ON items (location);
