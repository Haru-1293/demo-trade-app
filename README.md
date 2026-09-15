# demo-trade-app

日米対応デモトレードWebアプリ（学習用途）。詳細仕様は [`docs/spec.md`](./docs/spec.md) を参照。

## スタック

- Cloudflare Workers + Hono (TypeScript)
- Cloudflare D1（データストア）
- 静的フロント（Workers Static Assets配信）
- 外部データ: Yahoo Finance Chart API（`query1`/`query2`フォールバック、60秒キャッシュ）

## セットアップ

```bash
npm install
wrangler d1 create demo-trade-db   # 発行されたdatabase_idをwrangler.jsonへ反映
npm run db:migrate:local
```

### 必須シークレット（`wrangler secret put` で設定。wrangler.jsonには書かない）

| シークレット名 | 用途 |
|---|---|
| `TURNSTILE_SECRET_KEY` | ログイン・登録時のBOT検証 |
| `CSRF_SECRET` | CSRFトークン生成用（現在の実装はダブルサブミットクッキー方式のためcookie値そのものを比較。将来的に署名検証へ強化する場合に使用） |

Cloudflareダッシュボード側での設定が別途必要なもの:
- Bot Management（Bot Fight Mode）をゾーンで有効化
- Turnstile サイトキー発行
- 独自ドメイン移行時は `USE_WORKER_PROXY` を `"false"` に変更し、Response Header Modification Rules を設定

## ディレクトリ構成

```
migrations/     D1マイグレーションSQL（0001: users/sessions/symbols, 0002: trades/orders, 0003: fx/audit log）
src/
  index.ts      Honoルーティングのエントリポイント
  middleware/   認証・CSRF・レート制限
  routes/       auth / orders / portfolio / fx / admin
  services/     marketData（Yahoo Finance） / balance（余力計算・ロック） / limitCheck（指値遡及判定） / crypto
public/         静的フロント（未実装、プレースホルダーのみ）
```

## 現在の状態

スキーマとAPIルーティングの骨組みまで。`TODO`コメントの箇所（成行/指値の約定処理本体、Turnstile検証、売却可能株数計算、指値執行時のtrades更新など）は未実装。
