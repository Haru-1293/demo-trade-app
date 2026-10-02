-- 0009_asset_snapshots.sql
-- マイページ用の日次資産スナップショット（仕様書 7.4）
CREATE TABLE asset_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  snapshot_date TEXT NOT NULL, -- YYYY-MM-DD（JST基準）
  cash_jpy_c INTEGER NOT NULL,
  cash_usd_c INTEGER NOT NULL,
  valuation_jpy_c INTEGER NOT NULL, -- 保有株式の時価評価額（円換算）
  total_assets_jpy_c INTEGER NOT NULL, -- 現金+評価額の合計（円換算）
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_asset_snapshots_user_date ON asset_snapshots(user_id, snapshot_date);
