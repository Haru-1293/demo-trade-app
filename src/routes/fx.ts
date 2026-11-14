import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { fxRateLimit } from '../middleware/rateLimit';
import { exchangeCurrency } from '../services/fxService';

const app = new Hono<{ Bindings: Env }>();

/** GET /api/fx/transactions — 自分の両替履歴（4.7） */
app.get('/transactions', requireAuth, async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM fx_transactions WHERE user_id = ? ORDER BY executed_at DESC`,
  )
    .bind(auth.userId)
    .all();
  return c.json({ transactions: results });
});

/** POST /api/fx/exchange — 仕様書4.6（処理は services/fxService.ts。MCPと共通） */
app.post('/exchange', requireCsrf, requireAuth, fxRateLimit, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ direction?: unknown; amount_c?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
  const r = await exchangeCurrency(c.env, auth.userId, body.direction, body.amount_c);
  return c.json(r.body, r.status as 200 | 400 | 503);
});

export default app;
