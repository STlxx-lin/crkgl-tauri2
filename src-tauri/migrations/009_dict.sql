-- 009: 统一字典表。
--
-- 单位 / 类别 / 类型 / 出库部门 / 采购人 原来都是自由文本，散在 items 与 ledger 里：
-- 「个」「只」「件」各写各的，下拉候选每次现查，同一个部门在台账里出现三种写法。
-- 这里把它们收进一张 dict 表，基础资料页维护，开单选，录入新值时自动补一条。
--
-- kind 取值见 dict.rs 的 KINDS：
--   unit      单位
--   category  类别
--   item_type 类型（外购件 / 加工件）
--   owner     出库部门（台账里叫「归属」）
--   buyer     采购人

CREATE TABLE IF NOT EXISTS dict (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    sort_no    INTEGER NOT NULL DEFAULT 0,   -- 手排顺序，0 表示按使用次数排
    hits       INTEGER NOT NULL DEFAULT 0,   -- 出现次数，用来排序与「常用」标注
    remark     TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_dict_kind_value ON dict (kind, value);
CREATE INDEX IF NOT EXISTS ix_dict_kind ON dict (kind, sort_no, value);

-- 单位：从物料主数据灌初值，按出现次数排。「0」是粘贴残留，不收。
INSERT INTO dict (kind, value, hits)
SELECT 'unit', TRIM(unit), COUNT(*)
FROM items
WHERE TRIM(COALESCE(unit, '')) NOT IN ('', '0')
GROUP BY TRIM(unit)
ON CONFLICT(kind, value) DO NOTHING;

-- 类别：旧版基础信息是早期导入留下的批次名，不是类别（见 006）
INSERT INTO dict (kind, value, hits)
SELECT 'category', TRIM(category), COUNT(*)
FROM items
WHERE TRIM(COALESCE(category, '')) <> ''
  AND TRIM(category) <> '旧版基础信息'
GROUP BY TRIM(category)
ON CONFLICT(kind, value) DO NOTHING;

-- 类型：外购件 / 加工件
INSERT INTO dict (kind, value, hits)
SELECT 'item_type', TRIM(item_type), COUNT(*)
FROM items
WHERE TRIM(COALESCE(item_type, '')) <> ''
GROUP BY TRIM(item_type)
ON CONFLICT(kind, value) DO NOTHING;

-- 出库部门：台账里叫「归属」
INSERT INTO dict (kind, value, hits)
SELECT 'owner', TRIM(owner), COUNT(*)
FROM ledger
WHERE TRIM(COALESCE(owner, '')) <> ''
GROUP BY TRIM(owner)
ON CONFLICT(kind, value) DO NOTHING;

-- 采购人
INSERT INTO dict (kind, value, hits)
SELECT 'buyer', TRIM(buyer), COUNT(*)
FROM ledger
WHERE TRIM(COALESCE(buyer, '')) <> ''
GROUP BY TRIM(buyer)
ON CONFLICT(kind, value) DO NOTHING;
