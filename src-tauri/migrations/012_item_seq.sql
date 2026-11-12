-- 012: 物料建档顺序
--
-- created_at 只精确到秒，导入时几千条在同一批事务里插进来，时间戳几乎全一样，
-- 「按新建时间排序」等于没排。这里补一个单调递增的自增序号：
-- 每次 INSERT 自动取当前最大值 +1，天然反映真实插入先后，且不依赖时钟。

ALTER TABLE items ADD COLUMN seq INTEGER;

-- 已有数据按现有 created_at 回填，同一秒内再按 id 兜底，保证历史记录也有稳定次序
UPDATE items
SET seq = (
    SELECT COUNT(*) FROM items AS earlier
    WHERE earlier.created_at < items.created_at
       OR (earlier.created_at = items.created_at AND earlier.id <= items.id)
);

-- 新插入的行自动取下一个号
CREATE TRIGGER IF NOT EXISTS trg_items_seq_ai
AFTER INSERT ON items
FOR EACH ROW
WHEN NEW.seq IS NULL
BEGIN
    UPDATE items SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM items) WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS ix_items_seq ON items (seq);
