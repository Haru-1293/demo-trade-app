import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { getDisplayPrices } from '../services/marketData';

const app = new Hono<{ Bindings: Env }>();

const MAX_SYMBOLS = 30; // 1リクエストで取れる銘柄数（キャッシュに無い分は外部取得するため上限を設ける）
const SYMBOL_PATTERN = /^[A-Za-z0-9.\-=^]{1,20}$/;

/**
 * GET /api/prices?symbols=7203.T,AAPL — 表示用の現在値（仕様書 4.14）
 * KV 30分キャッシュ。WSSの初回tickが届くまでの暫定表示や、マイページの評価額に使う。
 * 約定判定には使わない。取得できなかった銘柄はレスポンスに含めない。
 */
app.get('/prices', requireAuth, async (c) => {
  const raw = (c.req.query('symbols') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const symbols = [...new Set(raw)];
  if (!symbols.length) return c.json({ error: 'symbols required' }, 400);
  if (symbols.length > MAX_SYMBOLS) return c.json({ error: `symbols は最大${MAX_SYMBOLS}件までです` }, 400);
  if (symbols.some((s) => !SYMBOL_PATTERN.test(s))) return c.json({ error: 'invalid symbol' }, 400);

  const map = await getDisplayPrices(c.env, symbols);
  const prices: Record<string, { price: number; as_of: number }> = {};
  for (const [symbol, dp] of map) prices[symbol] = { price: dp.price, as_of: dp.asOf };
  return c.json({ prices });
});

export default app;
