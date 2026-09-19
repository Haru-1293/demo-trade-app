import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';

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

// 表示専用の現在値取得はWSS(/api/live-prices)に統一したため、
// HTTPスナップショット用のmarket-summaryエンドポイントは廃止した。
// 成行・指値の約定判定用のHTTP取得(services/marketData.ts)は引き続きこのファイルとは別に存在する。

export default app;
