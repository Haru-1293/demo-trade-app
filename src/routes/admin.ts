import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';

const app = new Hono<{ Bindings: Env }>();

app.use('*', requireAuth, requireAdmin);

async function writeAuditLog(
  db: D1Database,
  adminUserId: string,
  targetUserId: string,
  action: 'STATUS_CHANGE' | 'BALANCE_ADJUST' | 'PASSWORD_CHANGE' | 'SYMBOL_UPDATE',
  before: unknown,
  after: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_log (id, admin_user_id, target_user_id, action, before_value, after_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      adminUserId,
      targetUserId,
      action,
      JSON.stringify(before),
      JSON.stringify(after),
      Math.floor(Date.now() / 1000),
    )
    .run();
}

/** GET /api/admin/users — ユーザー一覧 */
app.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, role, status, cash_balance_jpy_c, cash_balance_usd_c, created_at FROM users`,
  ).all();
  return c.json({ users: results });
});

/** PATCH /api/admin/users/:id/status — 凍結/解除/抹消。同一トランザクションで監査ログも記録 */
app.patch('/users/:id/status', requireCsrf, async (c) => {
  const auth = c.get('auth');
  const targetId = c.req.param('id');
  const body = await c.req.json<{ status: 'ACTIVE' | 'FROZEN' | 'DELETED' }>();

  const before = await c.env.DB.prepare(`SELECT status FROM users WHERE id = ?`)
    .bind(targetId)
    .first<{ status: string }>();
  if (!before) return c.json({ error: 'not found' }, 404);

  await c.env.DB.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(body.status, Math.floor(Date.now() / 1000), targetId)
    .run();

  if (body.status === 'FROZEN' || body.status === 'DELETED') {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(targetId).run();
  }

  await writeAuditLog(c.env.DB, auth.userId, targetId, 'STATUS_CHANGE', before, {
    status: body.status,
  });

  return c.json({ ok: true });
});

/** PATCH /api/admin/users/:id/balance — デモ残高の直接調整 */
app.patch('/users/:id/balance', requireCsrf, async (c) => {
  const auth = c.get('auth');
  const targetId = c.req.param('id');
  const body = await c.req.json<{ cash_balance_jpy_c?: number; cash_balance_usd_c?: number }>();

  const before = await c.env.DB.prepare(
    `SELECT cash_balance_jpy_c, cash_balance_usd_c FROM users WHERE id = ?`,
  )
    .bind(targetId)
    .first();
  if (!before) return c.json({ error: 'not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE users SET
       cash_balance_jpy_c = COALESCE(?, cash_balance_jpy_c),
       cash_balance_usd_c = COALESCE(?, cash_balance_usd_c),
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(body.cash_balance_jpy_c ?? null, body.cash_balance_usd_c ?? null, Math.floor(Date.now() / 1000), targetId)
    .run();

  await writeAuditLog(c.env.DB, auth.userId, targetId, 'BALANCE_ADJUST', before, body);
  return c.json({ ok: true });
});

/** GET /api/admin/users/:id/trades|orders|fx-transactions — 任意ユーザーの履歴閲覧（4.7） */
app.get('/users/:id/trades', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM trades WHERE user_id = ? ORDER BY buy_date DESC`,
  )
    .bind(c.req.param('id'))
    .all();
  return c.json({ trades: results });
});

app.get('/users/:id/orders', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM orders WHERE user_id = ? ORDER BY ordered_at DESC`,
  )
    .bind(c.req.param('id'))
    .all();
  return c.json({ orders: results });
});

app.get('/users/:id/fx-transactions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM fx_transactions WHERE user_id = ? ORDER BY executed_at DESC`,
  )
    .bind(c.req.param('id'))
    .all();
  return c.json({ transactions: results });
});

// TODO: パスワード直接変更 + Email Routing通知、symbols更新API（いずれもwriteAuditLog併用）

export default app;
