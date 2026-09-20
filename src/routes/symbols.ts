import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/symbols — 銘柄一覧（検索・注文フォーム用）
 * クエリ無し(全件)の場合のみ、KVで12時間キャッシュしてから配信する（銘柄同期はCronで日次実行のため）。
 * 検索クエリ付きの場合はD1へ直接問い合わせる（結果セットが小さく、都度最新であるべきため）。
 */
app.get('/symbols', requireAuth, async (c) => {
  const q = c.req.query('q');

  if (!q) {
    const cacheKey = 'symbols_full_cache';
    const cached = await c.env.RATE_LIMIT_KV.get(cacheKey);
    if (cached) {
      return c.json({ symbols: JSON.parse(cached) });
    }

    const { results } = await c.env.DB.prepare(
      `SELECT code, market, symbol, name, currency, unit_size FROM symbols WHERE active = 1 ORDER BY market, code`,
    ).all();

    const ttl = Number(c.env.SYMBOL_CACHE_TTL_SECONDS || '43200');
    await c.env.RATE_LIMIT_KV.put(cacheKey, JSON.stringify(results), { expirationTtl: ttl });
    return c.json({ symbols: results });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT code, market, symbol, name, currency, unit_size FROM symbols
     WHERE active = 1 AND (code LIKE ? OR name LIKE ? OR symbol LIKE ?)
     ORDER BY market, code LIMIT 30`,
  )
    .bind(`%${q}%`, `%${q}%`, `%${q}%`)
    .all();
  return c.json({ symbols: results });
});

// 表示専用の現在値取得はWSS(/api/live-prices)に統一したため、
// HTTPスナップショット用のmarket-summaryエンドポイントは廃止した。
// 成行・指値の約定判定用のHTTP取得(services/marketData.ts)は引き続きこのファイルとは別に存在する。

export default app;
