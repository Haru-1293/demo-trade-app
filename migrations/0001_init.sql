-- 0001_init.sql
-- users / sessions / symbols （仕様書 3.1 参照）

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'DELETED')),
  -- 金額は最小単位(1/100)の INTEGER で保持。0.01円/0.01USD未満は切り捨て。
  cash_balance_jpy_c INTEGER NOT NULL DEFAULT 100000000, -- 1,000,000円 = 100,000,000銭
  cash_balance_usd_c INTEGER NOT NULL DEFAULT 0,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  lockout_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 凍結/抹消時の一括セッション削除を高速化するためのインデックス
CREATE INDEX idx_sessions_user_id ON sessions(user_id);

CREATE TABLE symbols (
  code TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('JP', 'US')),
  symbol TEXT UNIQUE NOT NULL, -- Yahoo Finance用シンボル（例: 7203.T, AAPL）
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('JPY', 'USD')),
  -- 数量入力UIの+/-ボタン増減単位。日本株=100, ETF=1, 米国株=1。
  -- サーバー側はこの倍数であることを強制しない（1株単位の直接入力も許可）。
  unit_size INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (code, market)
);
