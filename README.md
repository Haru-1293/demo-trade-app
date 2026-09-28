# demo-trade-app

日米対応デモトレードWebアプリ（学習用途）。詳細仕様は [`docs/spec.md`](./docs/spec.md) を参照。

## スタック

- Cloudflare Workers + Hono (TypeScript)
- Cloudflare D1（データストア）、Workers KV（レート制限・キャッシュ・WebAuthnチャレンジ）
- 静的フロント（Workers Static Assets配信、ビルド不要の素のHTML/CSS/JS）
- 外部データ: Yahoo Finance Chart API（`query1`/`query2`フォールバック、60秒キャッシュ、成行・指値の約定判定用）
- ライブ株価表示（表示専用）: Yahoo Finance WSSをWorker経由でパススルー中継（`/api/live-prices`）
- 銘柄マスタ自動同期: JPX公開の上場会社一覧(xlsx) + SEC `company_tickers.json`、毎日08:30(JST)にCronで更新
- 管理画面: 通常アプリとは独立したセッション。メール+パスワード or パスキー(WebAuthn、`@simplewebauthn/server`)

## セットアップ

```bash
npm install
wrangler d1 create demo-trade-db      # 発行されたdatabase_idをwrangler.jsonへ反映
wrangler kv namespace create RATE_LIMIT_KV  # 発行されたidをwrangler.jsonへ反映
npm run db:migrate:local
```

### 必須シークレット（`wrangler secret put` で設定。wrangler.jsonには書かない）

| シークレット名 | 用途 |
|---|---|
| `TURNSTILE_SECRET_KEY` | ログイン・登録・管理画面ログイン時のBOT検証 |
| `CSRF_SECRET` | 現状未使用（ダブルサブミットクッキー方式のためcookie値そのものを比較。署名検証へ強化する場合に使用） |

### 設定値はすべてビルド時環境変数で注入する（リポジトリ内の値は常にプレースホルダーのまま）

`wrangler.json`と`public/app.js`・`public/admin.js`内の設定値は、`__XXX__`形式のプレースホルダートークンのままコミットしておく（実際の値は一切コミットしない）。実際の値は以下の経路でのみ渡す:

- **ローカル開発（`wrangler dev`）**: 手元のファイルだけを一時的に書き換える（コミットしない）。
- **Cloudflare Workers Buildsでの自動デプロイ**: プロジェクト設定の **「Build variables and secrets」** に以下の環境変数をすべて登録する。`npm run deploy`実行時、`predeploy`スクリプト（`scripts/inject-config.mjs`）がこれらの値でプレースホルダーを置換してから`wrangler deploy`が走る。

  | 環境変数名 | 置換対象トークン | 内容 |
  |---|---|---|
  | `D1_DATABASE_ID` | `__D1_DATABASE_ID__` | D1データベースのID |
  | `KV_RATE_LIMIT_NAMESPACE_ID` | `__KV_RATE_LIMIT_NAMESPACE_ID__` | KV namespaceのID |
  | `TURNSTILE_SITE_KEY` | `__TURNSTILE_SITE_KEY__` | Turnstileのサイトキー（公開キー、`app.js`/`admin.js`内） |
  | `WEBAUTHN_RP_ID` | `__WEBAUTHN_RP_ID__` | パスキーのRP ID（ホスト名のみ、例: `demo-trade-app.example.workers.dev`） |
  | `WEBAUTHN_ORIGIN` | `__WEBAUTHN_ORIGIN__` | パスキーのオリジン（スキーム込み・末尾スラッシュなし、例: `https://demo-trade-app.example.workers.dev`） |
  | `SEC_USER_AGENT` | `__SEC_USER_AGENT__` | SEC取得時のUser-Agent（アプリ名+連絡先、フェアユースポリシー対応） |
  | `EMAIL_FROM_ADDRESS` | `__EMAIL_FROM_ADDRESS__` | パスワード変更通知メールの送信元（Email Routingで検証済みのアドレス） |

  併せて、プロジェクト設定の **「Deploy command」** を `npx wrangler deploy` から **`npm run deploy`** に変更しておくこと（npmの`predeploy`フックを効かせるため）。

  ※ `WEBAUTHN_ORIGIN`・`WEBAUTHN_RP_ID`は、誤って末尾スラッシュやスキームを含めても`src/services/webauthn.ts`が正規化するが、正しい形式で登録しておくこと。

- **Workerのランタイムシークレット**（Build variablesとは別物）: `TURNSTILE_SECRET_KEY`等、Worker実行時に`env`経由で参照する秘密情報は、Workerの Settings → Variables and Secrets（または`wrangler secret put`）に別途登録する。

Cloudflareダッシュボード側での設定が別途必要なもの:
- Bot Management（Bot Fight Mode）をゾーンで有効化
- Turnstile サイトキー発行（アプリ用・管理画面用）、`public/index.html`と`public/admin.html`の`__TURNSTILE_SITE_KEY__`を置き換え
- Email Routing（`send_email`バインディング、`SEND_EMAIL`）の宛先アドレス検証。`src/services/email.ts`の`FROM_ADDRESS`も検証済みアドレスに置き換え
- 独自ドメイン移行時は `USE_WORKER_PROXY` を `"false"` に変更し、Response Header Modification Rules を設定

## ディレクトリ構成

```
migrations/       D1マイグレーションSQL（0001〜0008、詳細はファイル名・コメント参照）
src/
  index.ts        Honoルーティングのエントリポイント + Cronトリガー(scheduled)
  middleware/      認証・CSRF・レート制限（通常アプリ用 / admin用は別ファイル）
  routes/          auth / orders / portfolio / fx / admin / adminAuth / symbols
  services/
    marketData.ts  Yahoo Finance Chart API（約定判定用、60秒キャッシュ）
    balance.ts     余力計算・資金ロック・FIFO売却処理
    limitCheck.ts  指値の自動遡及判定
    timezone.ts    指値有効期限の現地日付→UTC変換
    crypto.ts      パスワードハッシュ・セッショントークン
    turnstile.ts   Turnstile検証（共通）
    email.ts       パスワード変更通知メール（Email Routing）
    webauthn.ts    パスキー登録・認証（@simplewebauthn/serverのラッパー）
    symbolSync.ts  銘柄マスタ自動同期（JPX xlsx + SEC json）
public/
  index.html/app.js/styles.css   アプリ本体（LINE/Instagram風UI）
  admin.html/admin.js/admin.css  管理画面（独立ログイン、ユーザー管理・銘柄管理）
```

## 現在の状態

主要機能は実装済み（成行・指値の約定処理、円貨決済、両替、ライブ株価表示、管理画面、銘柄自動同期）。
ただし **実機（`wrangler dev`／実デプロイ）での動作確認は未実施**。特に以下は型チェックだけでは検証できていない:

- WebAuthnの登録・認証フロー（`@simplewebauthn/server`のバージョン間差異、ブラウザAPIとの整合性）
- `/api/live-prices`のWSSパススルー（Yahoo Finance側の接続可否）
- `data_j.xlsx`の列名（JPX側の書式が想定と異なる可能性）
- D1の`batch()`チャンクサイズが実際の上限に対して適切か

デプロイ前に一通り実機で確認することを推奨する。
