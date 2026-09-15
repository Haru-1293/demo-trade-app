-- 0004_trades_lock.sql
-- 指値売り(SELL_LIMIT)による二重使用防止のため、trades側に「ロック中の株数」を持たせる。
-- 売却可能株数 = quantity - locked_quantity （仕様書4.3参照）

ALTER TABLE trades ADD COLUMN locked_quantity INTEGER NOT NULL DEFAULT 0;
