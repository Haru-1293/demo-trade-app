import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { placeMarketOrder, placeLimitOrder, cancelOrder, type OrderResult } from '../services/orderService';

/**
 * 注文API。実処理は services/orderService.ts（MCPのツールと共用、仕様書4.18）。
 * ここはリクエストの受け渡しとステータスの変換だけを行う。
 */
const app = new Hono<{ Bindings: Env }>();

function respond(c: { json: (body: unknown, status?: ContentfulStatusCode) => Response }, r: OrderResult): Response {
  return c.json(r.body, r.status as ContentfulStatusCode);
}

/** POST /api/orders/market — 仕様書4.2 / 4.9 */
app.post('/orders/market', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  return respond(c, await placeMarketOrder(c.env, auth.userId, body));
});

/** POST /api/orders/limit — 仕様書4.3 / 4.9 */
app.post('/orders/limit', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  return respond(c, await placeLimitOrder(c.env, auth.userId, body));
});

/** POST /api/orders/:id/cancel — 仕様書4.3 / 4.9 */
app.post('/orders/:id/cancel', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  return respond(c, await cancelOrder(c.env, auth.userId, c.req.param('id')));
});

export default app;
