-- 0003_fx_audit.sql
-- fx_transactions / admin_audit_log （仕様書 3.1 参照）

CREATE TABLE fx_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('JPY_TO_USD', 'USD_TO_JPY')),
  source_amount_c INTEGER NOT NULL,
  fx_rate REAL NOT NULL,
  result_amount_c INTEGER NOT NULL, -- 0.01未満切り捨て後
  executed_at INTEGER NOT NULL
);

CREATE INDEX idx_fx_transactions_user_id ON fx_transactions(user_id);

CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (
    action IN ('STATUS_CHANGE', 'BALANCE_ADJUST', 'PASSWORD_CHANGE', 'SYMBOL_UPDATE')
  ),
  before_value TEXT, -- JSON文字列
  after_value TEXT,  -- JSON文字列
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_admin_audit_log_target ON admin_audit_log(target_user_id);
