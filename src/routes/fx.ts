import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { fxRateLimit } from '../middleware/rateLimit';
import { getUsdJpyRate } from '../services/marketData';
import { tryDeductCash, creditCash } from '../services/balance';

const app = new Hono<{ Bindings: Env }>();

interface FxExchangeBody {
  direction: 'JPY_TO_USD' | 'USD_TO_JPY';
  amount_c: number; // 両替元通貨での金額（銭 or セント）
}

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

/** POST /api/fx/exchange — 仕様書4.6 */
app.post('/exchange', requireCsrf, requireAuth, fxRateLimit, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<FxExchangeBody>();

  if (!Number.isInteger(body.amount_c) || body.amount_c <= 0) {
    return c.json({ error: 'invalid amount' }, 400);
  }

  const rateQuote = await getUsdJpyRate(c.env);
  if (!rateQuote) return c.json({ error: 'fx data unavailable' }, 503);

  const sourceCurrency = body.direction === 'JPY_TO_USD' ? 'JPY' : 'USD';
  const destCurrency = body.direction === 'JPY_TO_USD' ? 'USD' : 'JPY';

  const ok = await tryDeductCash(c.env.DB, auth.userId, sourceCurrency, body.amount_c);
  if (!ok) return c.json({ error: 'insufficient funds' }, 400);

  const resultC =
    body.direction === 'JPY_TO_USD'
      ? Math.floor(body.amount_c / rateQuote.price)
      : Math.floor(body.amount_c * rateQuote.price);

  await creditCash(c.env.DB, auth.userId, destCurrency, resultC);

  await c.env.DB.prepare(
    `INSERT INTO fx_transactions (id, user_id, direction, source_amount_c, fx_rate, result_amount_c, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      auth.userId,
      body.direction,
      body.amount_c,
      rateQuote.price,
      resultC,
      Math.floor(Date.now() / 1000),
    )
    .run();

  return c.json({ ok: true, result_amount_c: resultC, fx_rate: rateQuote.price });
});

export default app;
