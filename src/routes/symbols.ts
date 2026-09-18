import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { getCurrentPrice } from '../services/marketData';

const app = new Hono<{ Bindings: Env }>();

/** GET /api/symbols — 有効な銘柄一覧（検索・注文フォーム用） */
app.get('/symbols', requireAuth, async (c) => {
  const q = c.req.query('q');
  let stmt;
  if (q) {
    stmt = c.env.DB.prepare(
      `SELECT code, market, symbol, name, currency, unit_size FROM symbols
       WHERE active = 1 AND (code LIKE ? OR name LIKE ? OR symbol LIKE ?)
       ORDER BY market, code LIMIT 30`,
    ).bind(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    stmt = c.env.DB.prepare(
      `SELECT code, market, symbol, name, currency, unit_size FROM symbols WHERE active = 1 ORDER BY market, code LIMIT 50`,
    );
  }
  const { results } = await stmt.all();
  return c.json({ symbols: results });
});

/**
 * GET /api/market-summary — ヘッダーのティッカーバー用スナップショット
 * USD/JPY・日経平均(^N225)・NYダウ(^DJI)の現在値。
 * WS(/api/live-prices)接続が確立するまでの初期表示用で、こちらは既存の
 * 60秒キャッシュ付きHTTP取得(marketData.getCurrentPrice)を流用する。
 * 約定判定には使わない表示専用データ。
 */
app.get('/market-summary', requireAuth, async (c) => {
  const [usdjpy, nikkei, dow] = await Promise.all([
    getCurrentPrice(c.env, 'JPY=X'),
    getCurrentPrice(c.env, '^N225'),
    getCurrentPrice(c.env, '^DJI'),
  ]);
  return c.json({
    usdjpy: usdjpy?.price ?? null,
    nikkei: nikkei?.price ?? null,
    dow: dow?.price ?? null,
  });
});

export default app;
