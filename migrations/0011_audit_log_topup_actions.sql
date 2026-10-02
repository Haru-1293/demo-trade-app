-- 0011_audit_log_topup_actions.sql
-- 現金増額申請の承認/却下を監査ログへ記録できるよう、admin_audit_log の action CHECK 制約を拡張する。
-- SQLiteはCHECK制約を ALTER で変更できないため、テーブルを作り直す。
CREATE TABLE admin_audit_log_new (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (
    action IN (
      'STATUS_CHANGE', 'BALANCE_ADJUST', 'PASSWORD_CHANGE', 'SYMBOL_UPDATE',
      'CASH_TOPUP_APPROVE', 'CASH_TOPUP_REJECT'
    )
  ),
  before_value TEXT, -- JSON文字列
  after_value TEXT,  -- JSON文字列
  created_at INTEGER NOT NULL
);

INSERT INTO admin_audit_log_new (id, admin_user_id, target_user_id, action, before_value, after_value, created_at)
  SELECT id, admin_user_id, target_user_id, action, before_value, after_value, created_at FROM admin_audit_log;

DROP TABLE admin_audit_log;
ALTER TABLE admin_audit_log_new RENAME TO admin_audit_log;
CREATE INDEX idx_admin_audit_log_target ON admin_audit_log(target_user_id);
