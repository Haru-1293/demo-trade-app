import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { generateSalt, hashPassword } from '../services/crypto';
import { sendPasswordChangedEmail } from '../services/email';

const app = new Hono<{ Bindings: Env }>();

app.use('*', requireAuth, requireAdmin);

/**
 * 監査ログ用のD1PreparedStatementを組み立てる（実行はしない）。
 * 呼び出し元がメインの更新文と一緒に db.batch() へ渡すことで、
 * 「操作は行われたがログだけ記録されない」状態を防ぐ（仕様書4.5）。
 */
function buildAuditLogStatement(
  db: D1Database,
  adminUserId: string,
  targetUserId: string,
  action: 'STATUS_CHANGE' | 'BALANCE_ADJUST' | 'PASSWORD_CHANGE' | 'SYMBOL_UPDATE',
  before: unknown,
  after: unknown,
): D1PreparedStatement {
  return db
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
    );
}

/** GET /api/admin/users — ユーザー一覧 */
app.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, email, role, status, cash_balance_jpy_c, cash_balance_usd_c, created_at FROM users`,
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

  const stmts = [
    c.env.DB.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(body.status, Math.floor(Date.now() / 1000), targetId),
    buildAuditLogStatement(c.env.DB, auth.userId, targetId, 'STATUS_CHANGE', before, { status: body.status }),
  ];
  if (body.status === 'FROZEN' || body.status === 'DELETED') {
    stmts.push(c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(targetId));
  }
  await c.env.DB.batch(stmts);

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

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET
         cash_balance_jpy_c = COALESCE(?, cash_balance_jpy_c),
         cash_balance_usd_c = COALESCE(?, cash_balance_usd_c),
         updated_at = ?
       WHERE id = ?`,
    ).bind(body.cash_balance_jpy_c ?? null, body.cash_balance_usd_c ?? null, Math.floor(Date.now() / 1000), targetId),
    buildAuditLogStatement(c.env.DB, auth.userId, targetId, 'BALANCE_ADJUST', before, body),
  ]);

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

/**
 * PATCH /api/admin/users/:id/password — パスワードの直接変更（仕様書4.5）
 * パスワード更新＋監査ログはbatchで同一トランザクション化する。
 * メール送信はDB更新の確定後に行い、送信失敗でもパスワード変更自体は成功として扱う
 * （メール送信はEmail Routing側のネットワーク呼び出しでありD1トランザクションに含められないため）。
 */
app.patch('/users/:id/password', requireCsrf, async (c) => {
  const auth = c.get('auth');
  const targetId = c.req.param('id');
  const body = await c.req.json<{ newPassword: string }>();
  if (!body.newPassword || body.newPassword.length < 4) {
    return c.json({ error: 'invalid password' }, 400);
  }

  const target = await c.env.DB.prepare(`SELECT username, email FROM users WHERE id = ?`)
    .bind(targetId)
    .first<{ username: string; email: string | null }>();
  if (!target) return c.json({ error: 'not found' }, 404);

  const newSalt = generateSalt();
  const newHash = await hashPassword(body.newPassword, newSalt);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?`)
      .bind(newSalt, newHash, Math.floor(Date.now() / 1000), targetId),
    buildAuditLogStatement(c.env.DB, auth.userId, targetId, 'PASSWORD_CHANGE', {}, {}),
  ]);

  let emailSent = false;
  if (target.email) {
    emailSent = await sendPasswordChangedEmail(c.env, target.email, target.username);
  }

  return c.json({ ok: true, email_sent: emailSent, has_email: !!target.email });
});

/** GET /api/admin/symbols — 銘柄一覧（無効化済みも含め全件、管理画面用） */
app.get('/symbols', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT code, market, symbol, name, currency, unit_size, active FROM symbols ORDER BY market, code`,
  ).all();
  return c.json({ symbols: results });
});

interface SymbolUpsertBody {
  code: string;
  market: 'JP' | 'US';
  symbol: string;
  name: string;
  currency: 'JPY' | 'USD';
  unit_size: number;
  active: boolean;
}

/** POST /api/admin/symbols — 銘柄の新規追加（既存の場合はUPSERT） */
app.post('/symbols', requireCsrf, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<SymbolUpsertBody>();
  if (!body.code || !body.market || !body.symbol || !body.name || !body.currency) {
    return c.json({ error: 'missing required fields' }, 400);
  }
  if (!Number.isInteger(body.unit_size) || body.unit_size <= 0) {
    return c.json({ error: 'invalid unit_size' }, 400);
  }

  const before = await c.env.DB.prepare(`SELECT * FROM symbols WHERE code = ? AND market = ?`)
    .bind(body.code, body.market)
    .first();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO symbols (code, market, symbol, name, currency, unit_size, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code, market) DO UPDATE SET
         symbol = excluded.symbol, name = excluded.name, currency = excluded.currency,
         unit_size = excluded.unit_size, active = excluded.active`,
    ).bind(body.code, body.market, body.symbol, body.name, body.currency, body.unit_size, body.active ? 1 : 0),
    // symbolsはuser_idを持たないため、admin_audit_log.target_user_idは操作した管理者自身のIDを暫定的に使う
    buildAuditLogStatement(c.env.DB, auth.userId, auth.userId, 'SYMBOL_UPDATE', before, body),
  ]);

  return c.json({ ok: true }, 201);
});

/** PATCH /api/admin/symbols/:market/:code — 銘柄情報の更新・無効化 */
app.patch('/symbols/:market/:code', requireCsrf, async (c) => {
  const auth = c.get('auth');
  const market = c.req.param('market');
  const code = c.req.param('code');
  const body = await c.req.json<Partial<SymbolUpsertBody>>();

  const before = await c.env.DB.prepare(`SELECT * FROM symbols WHERE code = ? AND market = ?`)
    .bind(code, market)
    .first();
  if (!before) return c.json({ error: 'not found' }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE symbols SET
         symbol = COALESCE(?, symbol),
         name = COALESCE(?, name),
         currency = COALESCE(?, currency),
         unit_size = COALESCE(?, unit_size),
         active = COALESCE(?, active)
       WHERE code = ? AND market = ?`,
    ).bind(
      body.symbol ?? null,
      body.name ?? null,
      body.currency ?? null,
      body.unit_size ?? null,
      body.active == null ? null : body.active ? 1 : 0,
      code,
      market,
    ),
    buildAuditLogStatement(c.env.DB, auth.userId, auth.userId, 'SYMBOL_UPDATE', before, body),
  ]);

  return c.json({ ok: true });
});

export default app;
