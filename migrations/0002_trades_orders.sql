-- 0002_trades_orders.sql
-- trades / orders （仕様書 3.1 参照）

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('JP', 'US')),
  quantity INTEGER NOT NULL,
  buy_date TEXT NOT NULL,
  buy_price REAL NOT NULL,   -- 市場価格そのものはREALで保持（外部データをそのまま格納）
  buy_rate REAL NOT NULL,    -- 米国株以外は 1
  status TEXT NOT NULL DEFAULT 'HOLD' CHECK (status IN ('HOLD', 'SOLD')),
  sell_date TEXT,
  sell_price REAL,
  sell_rate REAL,
  -- 確定損益（銭単位）。計算式は仕様書3.1参照。0.01円未満切り捨て。
  profit_jpy_c INTEGER
);

CREATE INDEX idx_trades_user_id ON trades(user_id);
CREATE INDEX idx_trades_user_status ON trades(user_id, status);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT UNIQUE NOT NULL, -- 二重送信防止
  code TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('JP', 'US')),
  order_type TEXT NOT NULL CHECK (order_type IN ('BUY_MARKET', 'SELL_MARKET', 'BUY_LIMIT', 'SELL_LIMIT')),
  target_price REAL, -- 成行の場合はNULL
  quantity INTEGER NOT NULL,
  locked_amount_c INTEGER NOT NULL DEFAULT 0, -- 銭 or セント。currencyはmarketから判定
  ordered_at INTEGER NOT NULL,
  expires_at INTEGER, -- 指値のみ。現地日付23:59:59のUTC秒（最大14日先）
  checked_until INTEGER, -- 遡及判定の進捗（4.4参照）。判定処理の最後に必ず更新する
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'EXECUTED', 'EXPIRED', 'CANCELLED', 'REJECTED', 'DATA_UNAVAILABLE')
  ),
  executed_price REAL,
  executed_at INTEGER,
  executed_rate REAL
);

CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
