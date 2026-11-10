-- 004: 单价精度从「分」提到「万分之一元」。
--
-- 源表里 4,920 行单价是厘/丝级（0.202、0.216、0.096），按「分」存会截断，
-- 导致「数量 × 单价」重算对不上源表合计（累计偏差约 ¥4,784）。
-- 金额（合计）仍按「分」存：源表合计本身就是分精度，没有更细的值。
--
-- 做法：新增 price_micros（1e-4 元）并从旧分列换算，然后丢掉旧列，
-- 保证只有一份单价数据，不会出现两列打架。

ALTER TABLE ledger ADD COLUMN price_micros INTEGER;
UPDATE ledger SET price_micros = price_cents * 100 WHERE price_cents IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ledger_price ON ledger (price_micros) WHERE price_micros IS NOT NULL;

-- 物料主数据的参考单价同理
ALTER TABLE items ADD COLUMN price_micros INTEGER;
UPDATE items SET price_micros = price_cents * 100 WHERE price_cents IS NOT NULL;

-- 丢掉旧的分列（SQLite 3.35+ 支持 DROP COLUMN，bundled 版本满足）
ALTER TABLE ledger DROP COLUMN price_cents;
ALTER TABLE items DROP COLUMN price_cents;
