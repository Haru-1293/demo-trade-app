-- 0010_cash_topup_requests.sql
-- 現金増額申請（仕様書 7.5）
CREATE TABLE cash_topup_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL CHECK (currency IN ('JPY', 'USD')),
  amount_c INTEGER NOT NULL,
  reason TEXT, -- 申請理由・メモ（任意入力）
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT REFERENCES users(id) -- 承認/却下した管理者
);

CREATE INDEX idx_cash_topup_requests_user ON cash_topup_requests(user_id);
CREATE INDEX idx_cash_topup_requests_status ON cash_topup_requests(status);
