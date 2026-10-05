-- 0013_user_passkeys.sql
-- 標準ユーザーのパスキー認証（仕様書 4.16）

-- パスキーの用途を分ける。既存の管理画面用は 'ADMIN'、標準ユーザー用は 'USER'。
-- 標準アプリで登録したパスキーで管理画面にログインできないようにする（管理画面の独立認証を保つため）。
ALTER TABLE webauthn_credentials ADD COLUMN scope TEXT NOT NULL DEFAULT 'ADMIN';
ALTER TABLE webauthn_credentials ADD COLUMN last_used_at INTEGER;

-- 標準ユーザー用のチャレンジ（使い捨て・短命）。KVの書き込み上限を避けるためD1に置く。
-- USER_REG: 登録時。ユーザーごとに最新1件。USER_AUTH: ユーザー名なしログイン時。ユーザー未確定のため user_id は NULL。
CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY, -- base64url
  kind TEXT NOT NULL CHECK (kind IN ('USER_REG', 'USER_AUTH')),
  user_id TEXT REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_webauthn_challenges_user ON webauthn_challenges(user_id);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
