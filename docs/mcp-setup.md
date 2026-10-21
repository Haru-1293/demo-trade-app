# AIアプリ連携（MCP）の設定方法

デモトレードのMCPサーバーに、ChatGPT や Claude などのAIアプリをつなぐ手順です。接続すると、AIがあなたのデモ口座の閲覧や（許可した場合は）注文を行えます。資金は仮想で、実際のお金は動きません。

仕様の詳細は [`spec.md`](./spec.md) の 4.17（OAuth・承認画面）と 4.18（MCP）を参照してください。

## 0. 前提

- 以下の `https://demo-trade-app.haru-tkh11.workers.dev` は、自分のデプロイ先のURLに読み替えてください。
- デプロイ先に `migrations/0014_oauth.sql` が適用済みであること（デプロイでは自動適用されません）。
- デモトレードのアカウントを持っていること。承認画面でログインします（パスワードまたはパスキー）。

### 先に知っておく値

| 項目 | 値 |
|---|---|
| MCPサーバーURL | `https://demo-trade-app.haru-tkh11.workers.dev/mcp` |
| 認可サーバー（issuer） | `https://demo-trade-app.haru-tkh11.workers.dev` |
| 認可サーバーのメタデータ | `/.well-known/oauth-authorization-server` |
| 保護リソースのメタデータ | `/.well-known/oauth-protected-resource`（`/mcp` を付けた形も可） |
| 通信方式 | Streamable HTTP（応答は常に単一のJSON、SSEなし） |
| 認証 | OAuth 2.1（認可コード + PKCE `S256`）。クライアントシークレットなしの公開クライアント |

### 権限（スコープ）

| スコープ | できること | 承認画面の初期値 |
|---|---|---|
| `portfolio:read` | 資産・保有・注文履歴・取引履歴の閲覧 | ON |
| `market:read` | 銘柄検索・現在値の参照 | ON |
| `trade:write` | 注文の発注・取消（**デモ資金が動く**） | **OFF** |

承認画面で、スコープごとに許可するかどうかを選べます。注文までAIに任せたいときだけ `trade:write` をONにしてください。

---

## 1. ChatGPT（OAuthの高度な設定）

ChatGPTのコネクタ追加画面で「OAuth関連の高度な設定」を開き、次のとおり入力します。

### 登録方法

**「動的クライアント登録（DCR）」を選びます（推奨）。** ChatGPTが自分でクライアントを登録するので、クライアントIDやシークレットの入力は不要です。

| 項目 | 入力する値 |
|---|---|
| 登録方法 | 動的クライアント登録（DCR） |
| コールバックURL | ChatGPTが表示するもの（`https://chatgpt.com/connector/oauth/…`）。DCRなら自動で登録されます |
| OAuth クライアントID | 空欄（DCRでは自動） |
| OAuth クライアントシークレット | 空欄（このサーバーはシークレットを使いません） |
| トークンエンドポイントの認証方法 | **`none`** |

> CIMD（Client ID Metadata Document）にも対応していますが、ChatGPT側が自分のURLをクライアントIDとして出す仕組みのため、画面に選択肢があるときだけ使えます。通常はDCRで足ります。

### 手動で登録したいとき（ユーザー定義のOAuthクライアント）

DCRが選べない場合は、ChatGPTに表示されたコールバックURLを使って、クライアントを自分で登録します。

```bash
curl -s -X POST https://demo-trade-app.haru-tkh11.workers.dev/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "ChatGPT",
    "redirect_uris": ["<ChatGPTが表示したコールバックURL>"],
    "token_endpoint_auth_method": "none"
  }'
```

返ってきた `client_id` を「OAuth クライアントID」に入力します。**シークレットは発行されません**（空欄のまま。認証方法は `none`）。

> コールバックURLは、登録したものと**完全一致**する必要があります。ChatGPT側でコネクタを作り直してURLが変わったら、登録し直してください。

### OAuth エンドポイント

| 項目 | 入力する値 |
|---|---|
| 認証 URL | `https://demo-trade-app.haru-tkh11.workers.dev/oauth/authorize` |
| トークン URL | `https://demo-trade-app.haru-tkh11.workers.dev/oauth/token` |
| 登録 URL | `https://demo-trade-app.haru-tkh11.workers.dev/oauth/register` |
| 認証サーバーのベース | `https://demo-trade-app.haru-tkh11.workers.dev`（末尾のスラッシュなし） |
| リソース | `https://demo-trade-app.haru-tkh11.workers.dev/mcp` |

リソースは `urn:` ではなく、**MCPサーバーのURLそのもの**です（RFC 8707）。この値と違うトークンは、`/mcp` が受け付けません。

### スコープ

| 項目 | 入力する値 |
|---|---|
| デフォルトのスコープ | `portfolio:read market:read` |
| 基本スコープ | `portfolio:read market:read` |

- スペース区切りで入力します。
- 注文もAIにさせたいときは、デフォルトのスコープに `trade:write` を足します（`portfolio:read market:read trade:write`）。**承認画面で、注文の権限はあなたがもう一度選びます。**
- 承認画面でONにした範囲が、実際に付与される権限です。

### OpenID のサポート

**オフにしてください。** このサーバーはOAuth 2.1の認可サーバーで、OpenID Connect（IDトークン・ユーザー情報エンドポイント）は提供していません。

| 項目 | 入力する値 |
|---|---|
| OpenIDのサポート | オフ |
| OIDC構成情報 URL | 空欄 |
| OIDCユーザー情報エンドポイント | 空欄 |
| サポートされている OIDC スコープ | 空欄 |

> `/.well-known/openid-configuration` にも認可サーバーのメタデータを返しますが、これは検出のための別名です（`id_token` やユーザー情報は含みません）。OpenIDをオンにしないでください。

### 接続の流れ

1. 上の設定でコネクタを保存し、接続を開始する。
2. ブラウザでデモトレードの承認画面が開く。未ログインなら、先にログインする。
3. アプリ名・戻り先・権限を確認し、許可する権限を選んで「許可する」を押す。
4. ChatGPTに戻り、接続が完了する。

---

## 2. Claude（claude.ai）

1. 設定の「コネクタ」から「カスタムコネクタを追加」を選ぶ。
2. 名前を付け、URLに `https://demo-trade-app.haru-tkh11.workers.dev/mcp` を入力する。
3. 追加後に「接続」を押す。承認画面が開くので、許可する権限を選んで「許可する」を押す。

クライアントの登録は、Claudeが自動で行います（CIMDまたはDCR）。クライアントIDやシークレットの入力は要りません。

---

## 3. 設定画面での管理

デモトレードの「設定」→「連携アプリ」で、次のことができます。

- MCPサーバーのURLをコピーする
- 許可済みのアプリと権限、最後に使った時刻を見る
- **許可を取り消す**（取り消すと、そのアプリのトークンは即座に使えなくなります）

アカウントを削除すると、すべての許可が失効します。

---

## 4. AIが使えるツール

| ツール | 必要な権限 | 内容 |
|---|---|---|
| `get_account_summary` | `portfolio:read` | 現金・総資産・評価損益 |
| `get_holdings` | `portfolio:read` | 保有銘柄 |
| `get_orders` | `portfolio:read` | 注文履歴 |
| `get_trades` | `portfolio:read` | 取引履歴 |
| `search_symbols` | `market:read` | 銘柄検索（売買単位 `unit_size` を含む） |
| `get_prices` | `market:read` | 現在値（表示用） |
| `place_market_order` | `trade:write` | 成行注文 |
| `place_limit_order` | `trade:write` | 指値注文（`BUY_LIMIT` / `SELL_LIMIT`） |
| `cancel_order` | `trade:write` | 未約定の注文を取り消す |
| `modify_order` | `trade:write` | 未約定の指値注文の価格・数量・有効期限を変える |

付与された権限で使えないツールは、一覧に表示されません。

### 安全のための制限

- 注文は **1ユーザーあたり1分に10件まで**（変数 `MCP_ORDER_RATE_LIMIT_PER_MIN`）。呼び出し全体は1つの許可につき1分60回まで。
- 注文の権限は、承認画面で選ばない限り付与されません。
- 日本株の売買単位（通常100株）はサーバーでは強制しません。`search_symbols` の `unit_size` を見て数量を決めます。

---

## 5. うまくいかないとき

| 症状 | 確認すること |
|---|---|
| 接続時に「invalid_request」「redirect_uri」系のエラー | 戻り先URL（ChatGPTのコールバックURL）が登録内容と完全一致しているか。DCRを使うか、手動登録をやり直す |
| 承認画面が出ずエラー表示 | `client_id` や戻り先が不正。コネクタ設定を見直す。エラーは画面に出て、アプリには戻りません |
| 接続後に `401` | トークンのリソースが違う（「リソース」が `…/mcp` になっているか）、許可を取り消した、期限切れ（自動更新されないクライアントは再接続） |
| 注文系のツールが見えない | 承認画面で `trade:write` をONにしたか。設定の「連携アプリ」で権限を確認し、足りなければ再接続 |
| `403 Origin not allowed` | ブラウザから直接呼ぶ接続元のOriginが許可リストにない。Cloudflareの変数 `MCP_ALLOWED_ORIGINS` に追加する（既定は `https://claude.ai,https://claude.com`） |
| 「PKCE（`code_challenge_methods_supported` に `S256`）が見つからない」 | 認可サーバーのメタデータは `S256` を返しています（`/.well-known/oauth-authorization-server`）。**この機能を含むバージョンが、デプロイ先にまだ反映されていない**ことがほとんどです。`curl -s $BASE/.well-known/oauth-authorization-server` で `code_challenge_methods_supported` が出るか確認してください。404ならPRのマージ・デプロイ前です |
| 連携アプリが20件に達した | 設定の「連携アプリ」で使わないものを取り消す |
| DCRで `429` | 登録が多すぎる（同じIPから1時間10件まで）。時間を置く |

---

## 6. 動作確認用のコマンド

```bash
BASE=https://demo-trade-app.haru-tkh11.workers.dev

# 認可サーバーのメタデータ
curl -s $BASE/.well-known/oauth-authorization-server | jq .

# 保護リソースのメタデータ
curl -s $BASE/.well-known/oauth-protected-resource/mcp | jq .

# トークンなしで呼ぶと 401 と WWW-Authenticate が返る
curl -si -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -n 8
```

---

> 注: ChatGPT側の画面の項目名・選択肢は、利用時期によって異なることがあります。上の表は、項目の意味に合わせて対応づけています。
