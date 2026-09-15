-- 0005_orders_locked_lots.sql
-- SELL_LIMIT注文がどのtradesロットを何株ずつロックしたかを記録する。
-- 例: [{"trade_id":"...","qty":30},{"trade_id":"...","qty":20}]
-- 約定時のロット消費・キャンセル時のロック解除の両方で、対象ロットを一意に特定するために使う。

ALTER TABLE orders ADD COLUMN locked_lots TEXT;
