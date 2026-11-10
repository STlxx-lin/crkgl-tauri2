-- 001: 台账主体。user_version 由 db::migrate 推进，这里只写结构。

CREATE TABLE IF NOT EXISTS imports (
    id            INTEGER PRIMARY KEY,
    file_name     TEXT NOT NULL,
    file_hash     TEXT NOT NULL,
    sheets        TEXT NOT NULL,          -- JSON: [{sheet, header_row, rows, skipped}]
    imported_at   TEXT NOT NULL,
    row_count     INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    note          TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
    id               INTEGER PRIMARY KEY,
    import_id        INTEGER REFERENCES imports(id) ON DELETE CASCADE,
    sheet            TEXT NOT NULL,
    row_no           INTEGER NOT NULL,      -- 源表行号（Excel 里的行号）
    kind             TEXT NOT NULL,         -- in / out
    doc_date         TEXT,                  -- YYYY-MM-DD
    doc_no           TEXT,                  -- 单据编号 / 出库单号
    delivery_no      TEXT,                  -- 送货单号（入库独有）
    item_code        TEXT,
    item_name        TEXT,
    spec             TEXT,                  -- 规格/单位（入库明细没有单独规格列）
    unit             TEXT,
    qty              REAL,
    price_cents      INTEGER,               -- 单价（分）
    amount_cents     INTEGER,               -- 合计（分）
    remark           TEXT,
    partner          TEXT,                  -- 供应商名称（入库）
    buyer            TEXT,                  -- 采购人（入库）
    owner            TEXT,                  -- 归属（出库）
    receiver         TEXT,                  -- 领用人（出库）
    flags            TEXT NOT NULL DEFAULT '',  -- 逗号分隔的提醒：no_code,no_price,no_amount,qty_diff...
    created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS ix_ledger_date ON ledger (doc_date);
CREATE INDEX IF NOT EXISTS ix_ledger_kind_date ON ledger (kind, doc_date);
CREATE INDEX IF NOT EXISTS ix_ledger_owner ON ledger (owner);
CREATE INDEX IF NOT EXISTS ix_ledger_item ON ledger (item_code);
CREATE INDEX IF NOT EXISTS ix_ledger_name ON ledger (item_name);
CREATE INDEX IF NOT EXISTS ix_ledger_doc ON ledger (doc_no);

-- 表头 → 标准字段的记忆：换个表头名也能自动对上
CREATE TABLE IF NOT EXISTS header_alias (
    header TEXT PRIMARY KEY,
    field  TEXT NOT NULL
);

-- 本机设置（远程只读站开关、端口）
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 远程只读站的访问记录（保留最近 500 条）
CREATE TABLE IF NOT EXISTS access_log (
    id     INTEGER PRIMARY KEY,
    at     TEXT NOT NULL,
    ip     TEXT NOT NULL,
    path   TEXT NOT NULL,
    status INTEGER NOT NULL
);
