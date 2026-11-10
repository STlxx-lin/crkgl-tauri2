-- 002: 本机开单。手工新开的入库单/出库单与 Excel 导入的行分开记源，
-- 用 voucher_id 串回单据头，sheet 记成 `voucher:in` / `voucher:out`。

CREATE TABLE IF NOT EXISTS vouchers (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,               -- in / out
    doc_no       TEXT NOT NULL,               -- 单据编号（YYYYMMDD + 3 位流水）
    doc_date     TEXT NOT NULL,               -- YYYY-MM-DD
    partner      TEXT,                        -- 入库：供应商
    delivery_no  TEXT,                        -- 入库：送货单号
    buyer        TEXT,                        -- 入库：采购人
    owner        TEXT,                        -- 出库：归属
    receiver     TEXT,                        -- 出库：领用人
    remark       TEXT,
    row_count    INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_vouchers_doc_no ON vouchers (kind, doc_no);
CREATE INDEX IF NOT EXISTS ix_vouchers_date ON vouchers (doc_date);

-- SQLite 不支持 ADD COLUMN IF NOT EXISTS：重复执行会报 duplicate column。
-- 迁移已包在事务里，正常不会重复；这里保留原样以保持结构简单。
ALTER TABLE ledger ADD COLUMN voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS ix_ledger_voucher ON ledger (voucher_id);
