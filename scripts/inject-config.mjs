// ビルド時（Cloudflare Workers Buildsの"Build variables and secrets"）に設定した
// 環境変数で、各ファイル内のプレースホルダートークンを実際の値へ置き換える。
//
// これにより、リポジトリ自体（公開してもよい版）には実際のID・キーを一切コミットせず、
// 自動ビルド時にだけ実環境の値を注入できる。フォークやリポジトリ分割は不要。
// GitHub上のファイル内容は常にプレースホルダーのままでよく、手動編集は不要。
//
// 必須の環境変数（Cloudflareダッシュボードの Build variables and secrets に設定）:
//   D1_DATABASE_ID              — wrangler.json の "__D1_DATABASE_ID__" を置換
//   KV_RATE_LIMIT_NAMESPACE_ID  — wrangler.json の "__KV_RATE_LIMIT_NAMESPACE_ID__" を置換
//   TURNSTILE_SITE_KEY          — public/app.js と public/admin.js の
//                                  "__TURNSTILE_SITE_KEY__" を置換（クライアント側の公開キーなので機密ではない）
//   WEBAUTHN_RP_ID               — wrangler.json の "__WEBAUTHN_RP_ID__" を置換（例: example.com）
//   WEBAUTHN_ORIGIN               — wrangler.json の "__WEBAUTHN_ORIGIN__" を置換（例: https://example.com）
//                                  ※この2つが実際のデプロイ先ドメインと一致していないと、
//                                    パスキー登録・認証の検証(@simplewebauthn/server)が例外を投げて失敗する。
//
// 注意: TURNSTILE_SECRET_KEY（サーバー側の秘密キー）はこのビルド変数とは別物。
// そちらはWorker本体の実行時シークレット（Settings > Variables and Secrets、
// または `wrangler secret put TURNSTILE_SECRET_KEY`）として登録すること。
// このスクリプトが処理するのはビルド時にファイルへ焼き込む値のみで、
// Workerのランタイムシークレット（env経由でアクセスする値）には関与しない。
//
// package.json の "predeploy" スクリプトとして実行される想定
// （`npm run deploy` 実行時にnpmが自動で先に走らせる）。
// ローカル開発（wrangler dev）では手元のファイルを一時的に書き換えるか、
// 別途ローカル用の値を用意し、このスクリプトは通さない。

import fs from 'node:fs';

const TOKEN_TO_ENV_VAR = {
  __D1_DATABASE_ID__: 'D1_DATABASE_ID',
  __KV_RATE_LIMIT_NAMESPACE_ID__: 'KV_RATE_LIMIT_NAMESPACE_ID',
  __TURNSTILE_SITE_KEY__: 'TURNSTILE_SITE_KEY',
  __WEBAUTHN_RP_ID__: 'WEBAUTHN_RP_ID',
  __WEBAUTHN_ORIGIN__: 'WEBAUTHN_ORIGIN',
};

const FILES_TO_PROCESS = ['wrangler.json', 'public/app.js', 'public/admin.js'];

function main() {
  const missing = new Set();

  for (const filePath of FILES_TO_PROCESS) {
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;

    for (const [token, envVarName] of Object.entries(TOKEN_TO_ENV_VAR)) {
      if (!content.includes(token)) continue; // このファイルには該当トークンがない
      const value = process.env[envVarName];
      if (!value) {
        missing.add(`${envVarName}（${filePath} の "${token}"）`);
        continue;
      }
      content = content.split(token).join(value);
      changed = true;
    }

    if (changed) fs.writeFileSync(filePath, content);
  }

  if (missing.size > 0) {
    console.error(
      `[inject-config] 以下の環境変数が未設定のため置換できませんでした:\n  - ${[...missing].join('\n  - ')}\n` +
        'Cloudflareダッシュボードの「Build variables and secrets」に設定してください。',
    );
    process.exit(1);
  }

  console.log('[inject-config] ビルド環境変数の注入が完了しました');
}

main();
