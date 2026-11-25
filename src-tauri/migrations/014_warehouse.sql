-- 014: 多仓库
--
-- 业务数据（台账 / 单据 / 导入记录）按仓库隔离，基础资料（物料 / 供应商 / 字典）
-- 全库通用——一个物料在两三个仓库里是同一份档案，只是流水分开记。
--
-- 为什么不做「一仓一个数据库文件」：基础资料要共用。分库就得 ATTACH 或复制，
-- 每次维护物料都要同步到每个文件，比现在多加一列麻烦得多。
--
-- 注意两件事：
-- 1) `ADD COLUMN ... REFERENCES` 在开启外键时只允许默认值 NULL，而这里要
--    NOT NULL DEFAULT 1，所以列上不带外键，完整性由 warehouse.rs 的删除前
--    检查保证（有数据的仓库不让删，除非显式 force）。
-- 2) 旧索引全部是「日期优先」，加了仓库条件后必须换成仓库前缀，否则每次
--    查询都会退化成「扫描 + 临时排序」。

CREATE TABLE IF NOT EXISTS warehouses (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    remark     TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    sort_no    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 老库升级：已有数据全部归到「主仓库」，单据编号、日期区间保持原样
INSERT INTO warehouses (id, name, sort_no) VALUES (1, '主仓库', 0)
ON CONFLICT(id) DO NOTHING;

ALTER TABLE ledger   ADD COLUMN warehouse_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vouchers ADD COLUMN warehouse_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE imports  ADD COLUMN warehouse_id INTEGER NOT NULL DEFAULT 1;

-- 台账：把旧的「日期优先」索引换成「仓库优先」
DROP INDEX IF EXISTS ix_ledger_date;
DROP INDEX IF EXISTS ix_ledger_date_id;
DROP INDEX IF EXISTS ix_ledger_kind_date;
DROP INDEX IF EXISTS ix_ledger_kind_date_id;
DROP INDEX IF EXISTS ix_ledger_owner;
DROP INDEX IF EXISTS ix_ledger_item;
DROP INDEX IF EXISTS ix_ledger_name;
DROP INDEX IF EXISTS ix_ledger_doc;
DROP INDEX IF EXISTS ix_ledger_partner;
DROP INDEX IF EXISTS ix_ledger_buyer;
DROP INDEX IF EXISTS ix_ledger_price;
DROP INDEX IF EXISTS ix_ledger_stock_perf;
DROP INDEX IF EXISTS ix_ledger_import_id;
DROP INDEX IF EXISTS ix_ledger_voucher;

CREATE INDEX IF NOT EXISTS ix_ledger_wh_date_id        ON ledger (warehouse_id, doc_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_kind_date_id   ON ledger (warehouse_id, kind, doc_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_item           ON ledger (warehouse_id, item_code, kind, doc_date DESC, id DESC, price_micros);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_owner          ON ledger (warehouse_id, owner);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_partner        ON ledger (warehouse_id, partner);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_buyer          ON ledger (warehouse_id, buyer);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_doc            ON ledger (warehouse_id, doc_no);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_name           ON ledger (warehouse_id, item_name);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_import         ON ledger (warehouse_id, import_id);
CREATE INDEX IF NOT EXISTS ix_ledger_wh_voucher        ON ledger (warehouse_id, voucher_id);

-- 单据：编号唯一性必须按仓库算，否则两个仓同一天都从 001 起号会撞
DROP INDEX IF EXISTS ux_vouchers_doc_no;
DROP INDEX IF EXISTS ix_vouchers_date;

CREATE UNIQUE INDEX IF NOT EXISTS ux_vouchers_wh_doc_no ON vouchers (warehouse_id, kind, doc_no);
CREATE INDEX IF NOT EXISTS ix_vouchers_wh_date          ON vouchers (warehouse_id, doc_date DESC, id DESC);

-- 导入：同一个 Excel 可以分别导进两个仓库，重复检测也按仓库算
DROP INDEX IF EXISTS ix_imports_hash;
CREATE INDEX IF NOT EXISTS ix_imports_wh_hash ON imports (warehouse_id, file_hash);
