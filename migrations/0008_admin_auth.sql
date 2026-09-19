-- 0008_admin_auth.sql
-- 管理画面を通常アプリのセッションから完全に分離するための専用テーブル群。

CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_admin_sessions_user_id ON admin_sessions(user_id);

-- WebAuthn(パスキー)の登録情報。1ユーザーが複数の認証器(端末)を登録できるよう複数行を許可する。
CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT UNIQUE NOT NULL, -- base64url
  public_key TEXT NOT NULL,           -- base64url化したCOSE公開鍵
  counter INTEGER NOT NULL DEFAULT 0, -- リプレイ攻撃対策の署名カウンタ
  transports TEXT,                    -- JSON配列文字列（例: ["internal","hybrid"]）、任意
  label TEXT,                         -- 管理画面での表示用ラベル（登録時のUser-Agent等）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_webauthn_credentials_user_id ON webauthn_credentials(user_id);
