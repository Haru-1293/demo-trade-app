import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';

const app = new Hono<{ Bindings: Env }>();

const MAX_AMOUNT = 1_000_000_000; // 1回の申請上限（各通貨の単位）
const MAX_REASON_LENGTH = 500;
const MAX_PENDING_PER_USER = 5;

/** POST /api/cash-topup-requests — 現金増額申請（仕様書 7.5）。承認されるまで残高は変わらない */
app.post('/cash-topup-requests', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req
    .json<{ currency: 'JPY' | 'USD'; amount: number; reason?: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);

  if (body.currency !== 'JPY' && body.currency !== 'USD') {
    return c.json({ error: '通貨が不正です' }, 400);
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return c.json({ error: '金額が不正です' }, 400);
  }
  if (body.currency === 'JPY' && !Number.isInteger(amount)) {
    return c.json({ error: '円は整数で入力してください' }, 400);
  }
  const amountC = Math.round(amount * 100);
  if (amountC <= 0) return c.json({ error: '金額が不正です' }, 400);

  const reason = (body.reason ?? '').trim();
  if (reason.length > MAX_REASON_LENGTH) {
    return c.json({ error: `理由は${MAX_REASON_LENGTH}文字以内で入力してください` }, 400);
  }

  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM cash_topup_requests WHERE user_id = ? AND status = 'PENDING'`,
  )
    .bind(auth.userId)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PER_USER) {
    return c.json({ error: `承認待ちの申請が${MAX_PENDING_PER_USER}件あります。承認・却下をお待ちください` }, 429);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO cash_topup_requests (id, user_id, currency, amount_c, reason, status, requested_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
  )
    .bind(id, auth.userId, body.currency, amountC, reason || null, Math.floor(Date.now() / 1000))
    .run();

  return c.json({ id }, 201);
});

/** GET /api/cash-topup-requests — 自分の申請履歴（履歴画面「入出金」タブ用） */
app.get('/cash-topup-requests', requireAuth, async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT id, currency, amount_c, reason, status, requested_at, decided_at
     FROM cash_topup_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT 200`,
  )
    .bind(auth.userId)
    .all();
  return c.json({ requests: results });
});

export default app;
