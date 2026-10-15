-- 0014_oauth.sql
-- OAuth 2.0 認可サーバー（リモートMCPサーバー用、仕様書 4.17 / 3.1 の13〜16）

-- クライアント: DCR（動的登録）とCIMD（Client ID Metadata Documents）の両方をここに置く。
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY, -- DCR: 'mcp_' + ランダム値 / CIMD: クライアントのHTTPS URLそのもの
  kind TEXT NOT NULL CHECK (kind IN ('DCR', 'CIMD')),
  client_name TEXT NOT NULL, -- 自己申告の表示名（未検証）
  redirect_uris TEXT NOT NULL, -- JSON配列
  client_uri TEXT,
  registered_ip_hash TEXT, -- DCRの登録元IPのSHA-256（濫用対策のレート制限用。IPそのものは保存しない）
  created_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL -- CIMDは文書を最後に取得した時刻。DCRは登録時刻
);
CREATE INDEX idx_oauth_clients_ip ON oauth_clients(registered_ip_hash, created_at);
CREATE INDEX idx_oauth_clients_kind_created ON oauth_clients(kind, created_at);

-- ユーザーがクライアントに与えた許可
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  scope TEXT NOT NULL, -- 承認画面でユーザーが許可した権限（空白区切り）
  resource TEXT NOT NULL, -- トークンの宛先（https://<サイト>/mcp）
  created_at INTEGER NOT NULL,
  activated_at INTEGER, -- 認可コードが最初に使われた時刻。NULLの間は連携アプリ一覧に出さない
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_oauth_grants_user ON oauth_grants(user_id);
CREATE INDEX idx_oauth_grants_client ON oauth_grants(client_id);

-- 認可コード（120秒・1回限り。ハッシュのみ保存）
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL, -- PKCE S256
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_oauth_codes_grant ON oauth_codes(grant_id);
CREATE INDEX idx_oauth_codes_expires ON oauth_codes(expires_at);

-- アクセストークン・リフレッシュトークン（トークンそのものは保存せず、SHA-256のハッシュのみ）
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ACCESS', 'REFRESH')),
  scope TEXT NOT NULL, -- このトークンの権限（許可の範囲内。リフレッシュ時に縮小できる）
  expires_at INTEGER NOT NULL,
  used_at INTEGER, -- リフレッシュトークンが使われた時刻（ローテーション済みの印）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at);
