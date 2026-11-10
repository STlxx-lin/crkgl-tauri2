-- 003: 基础资料。物料主数据与供应商从工作簿的「物料编号」「供应商名称」表导入，
-- 之后可以在「基础资料」页维护，开单时直接用。

CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY,
    item_code     TEXT NOT NULL UNIQUE,   -- 物料编码（WG-ZCL-0001）
    item_name     TEXT NOT NULL,          -- 物料名称（51101）
    category      TEXT,                   -- 物料类别（轴承类）
    unit          TEXT,                   -- 单位
    price_cents   INTEGER,                -- 参考单价（分）
    spec          TEXT,                   -- 规格型号（工作簿里没有单独列，保留字段）
    owner         TEXT,                   -- 归属
    supplier      TEXT,                   -- 默认供应商
    remark        TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS ix_items_name ON items (item_name);
CREATE INDEX IF NOT EXISTS ix_items_category ON items (category);

CREATE TABLE IF NOT EXISTS suppliers (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    contact    TEXT,
    phone      TEXT,
    remark     TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
