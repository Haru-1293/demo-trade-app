// ビルド時（Cloudflare Workers Buildsの"Build variables and secrets"）に設定した
// 環境変数で wrangler.json のプレースホルダートークンを実IDへ置き換える。
//
// これにより、リポジトリ自体（公開してもよい版）には実際のD1/KVのIDを一切コミットせず、
// 自動ビルド時にだけ実環境の値を注入できる。フォークやリポジトリ分割は不要。
//
// 必須の環境変数（Cloudflareダッシュボードの Build variables and secrets に設定）:
//   D1_DATABASE_ID              — wrangler.json の "__D1_DATABASE_ID__" を置換
//   KV_RATE_LIMIT_NAMESPACE_ID  — wrangler.json の "__KV_RATE_LIMIT_NAMESPACE_ID__" を置換
//
// package.json の "predeploy" スクリプトとして実行される想定
// （`npm run deploy` 実行時にnpmが自動で先に走らせる）。
// ローカル開発（wrangler dev）では .dev.vars 等で別途値を用意し、このスクリプトは通さない。

import fs from 'node:fs';

const WRANGLER_CONFIG_PATH = 'wrangler.json';

const TOKEN_TO_ENV_VAR = {
  __D1_DATABASE_ID__: 'D1_DATABASE_ID',
  __KV_RATE_LIMIT_NAMESPACE_ID__: 'KV_RATE_LIMIT_NAMESPACE_ID',
};

function main() {
  let content = fs.readFileSync(WRANGLER_CONFIG_PATH, 'utf8');
  const missing = [];

  for (const [token, envVarName] of Object.entries(TOKEN_TO_ENV_VAR)) {
    const value = process.env[envVarName];
    if (!content.includes(token)) continue; // 既に置換済み（ローカルで手動編集済み等）なら何もしない
    if (!value) {
      missing.push(envVarName);
      continue;
    }
    content = content.split(token).join(value);
  }

  if (missing.length > 0) {
    console.error(
      `[inject-config] 以下の環境変数が未設定のため wrangler.json を置換できませんでした: ${missing.join(', ')}\n` +
        'Cloudflareダッシュボードの「Build variables and secrets」に設定してください。',
    );
    process.exit(1);
  }

  fs.writeFileSync(WRANGLER_CONFIG_PATH, content);
  console.log('[inject-config] wrangler.json へビルド環境変数を注入しました');
}

main();
