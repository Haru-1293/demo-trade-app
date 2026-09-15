import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { checkPendingLimitOrders } from '../services/limitCheck';

const app = new Hono<{ Bindings: Env }>();

/** GET /api/portfolio — 保有中(HOLD)取引一覧。アクセス時に指値遡及判定をトリガー（4.4） */
app.get('/portfolio', requireAuth, async (c) => {
  const auth = c.get('auth');
  await checkPendingLimitOrders(c.env, auth.userId);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM trades WHERE user_id = ? AND status = 'HOLD' ORDER BY buy_date DESC`,
  )
    .bind(auth.userId)
    .all();
  return c.json({ trades: results });
});

/** GET /api/trades — 保有中・売却済みを含む全取引履歴（4.7） */
app.get('/trades', requireAuth, async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM trades WHERE user_id = ? ORDER BY buy_date DESC`,
  )
    .bind(auth.userId)
    .all();
  return c.json({ trades: results });
});

/** GET /api/orders — 自分の注文履歴(全ステータス)。アクセス時に指値遡及判定をトリガー（4.4） */
app.get('/orders', requireAuth, async (c) => {
  const auth = c.get('auth');
  await checkPendingLimitOrders(c.env, auth.userId);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM orders WHERE user_id = ? ORDER BY ordered_at DESC`,
  )
    .bind(auth.userId)
    .all();
  return c.json({ orders: results });
});

export default app;
