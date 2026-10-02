import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAdminSession, requireAdminCsrf } from '../middleware/adminAuth';

import { generateSalt, hashPassword } from '../services/crypto';
import { sendPasswordChangedEmail } from '../services/email';
import { syncSymbols } from '../services/symbolSync';

const app = new Hono<{ Bindings: Env }>();

app.use('*', requireAdminSession);

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
app.patch('/users/:id/status', requireAdminCsrf, async (c) => {
  const adminAuth = c.get('adminAuth');
  const targetId = c.req.param('id');
  const body = await c.req.json<{ status: 'ACTIVE' | 'FROZEN' | 'DELETED' }>();

  const before = await c.env.DB.prepare(`SELECT status FROM users WHERE id = ?`)
    .bind(targetId)
    .first<{ status: string }>();
  if (!before) return c.json({ error: 'not found' }, 404);

  const stmts = [
    c.env.DB.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(body.status, Math.floor(Date.now() / 1000), targetId),
    buildAuditLogStatement(c.env.DB, adminAuth.userId, targetId, 'STATUS_CHANGE', before, { status: body.status }),
  ];
  if (body.status === 'FROZEN' || body.status === 'DELETED') {
    stmts.push(c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(targetId));
  }
  await c.env.DB.batch(stmts);

  return c.json({ ok: true });
});

/** PATCH /api/admin/users/:id/balance — デモ残高の直接調整 */
app.patch('/users/:id/balance', requireAdminCsrf, async (c) => {
  const adminAuth = c.get('adminAuth');
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
    buildAuditLogStatement(c.env.DB, adminAuth.userId, targetId, 'BALANCE_ADJUST', before, body),
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
app.patch('/users/:id/password', requireAdminCsrf, async (c) => {
  const adminAuth = c.get('adminAuth');
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
    buildAuditLogStatement(c.env.DB, adminAuth.userId, targetId, 'PASSWORD_CHANGE', {}, {}),
  ]);

  let emailSent = false;
  if (target.email) {
    emailSent = await sendPasswordChangedEmail(c.env, target.email, target.username);
  }

  return c.json({ ok: true, email_sent: emailSent, has_email: !!target.email });
});

/**
 * POST /api/admin/symbols/sync — 銘柄マスタの手動同期（Cronを待たずに即時実行）。
 * JPX(日本株)・SEC(米国株)いずれかの取得に失敗しても、成功した方は反映したうえでエラーを返す。
 */
app.post('/symbols/sync', requireAdminCsrf, async (c) => {
  const result = await syncSymbols(c.env);
  return c.json(result, result.errors.length > 0 ? 207 : 200);
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
app.post('/symbols', requireAdminCsrf, async (c) => {
  const adminAuth = c.get('adminAuth');
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
    buildAuditLogStatement(c.env.DB, adminAuth.userId, adminAuth.userId, 'SYMBOL_UPDATE', before, body),
  ]);

  return c.json({ ok: true }, 201);
});

/** PATCH /api/admin/symbols/:market/:code — 銘柄情報の更新・無効化 */
app.patch('/symbols/:market/:code', requireAdminCsrf, async (c) => {
  const adminAuth = c.get('adminAuth');
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
    buildAuditLogStatement(c.env.DB, adminAuth.userId, adminAuth.userId, 'SYMBOL_UPDATE', before, body),
  ]);

  return c.json({ ok: true });
});


/**
 * GET /api/admin/cash-topup-requests?status=PENDING|APPROVED|REJECTED|ALL — 現金増額申請の一覧（仕様書7.5）
 * 既定は承認待ち(PENDING)。申請の古い順に返す。
 */
app.get('/cash-topup-requests', async (c) => {
  const status = c.req.query('status') ?? 'PENDING';
  const filter = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? status : null;
  const sql = `SELECT r.id, r.user_id, u.username, r.currency, r.amount_c, r.reason, r.status,
                      r.requested_at, r.decided_at
               FROM cash_topup_requests r JOIN users u ON u.id = r.user_id
               ${filter ? 'WHERE r.status = ?' : ''}
               ORDER BY ${filter === 'PENDING' ? 'r.requested_at ASC' : 'r.requested_at DESC'}
               LIMIT 200`;
  const stmt = c.env.DB.prepare(sql);
  const { results } = await (filter ? stmt.bind(filter) : stmt).all();
  return c.json({ requests: results });
});

/**
 * PATCH /api/admin/cash-topup-requests/:id — 承認/却下（仕様書7.5）
 * 承認時は残高加算・申請ステータス更新・監査ログを1バッチで行う。
 * どの文も「申請がPENDINGであること」を条件にしているため、二重承認しても二重加算されない。
 */
app.patch('/cash-topup-requests/:id', requireAdminCsrf, async (c) => {
  const adminAuth = c.get('adminAuth');
  const id = c.req.param('id');
  const body = await c.req.json<{ status: 'APPROVED' | 'REJECTED' }>().catch(() => null);
  if (!body || (body.status !== 'APPROVED' && body.status !== 'REJECTED')) {
    return c.json({ error: 'status must be APPROVED or REJECTED' }, 400);
  }

  const req = await c.env.DB.prepare(
    `SELECT r.id, r.user_id, r.currency, r.amount_c, r.status, u.status AS user_status
     FROM cash_topup_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
  )
    .bind(id)
    .first<{ id: string; user_id: string; currency: 'JPY' | 'USD'; amount_c: number; status: string; user_status: string }>();
  if (!req) return c.json({ error: 'not found' }, 404);
  if (req.status !== 'PENDING') return c.json({ error: 'すでに処理済みの申請です' }, 409);
  if (body.status === 'APPROVED' && req.user_status !== 'ACTIVE') {
    return c.json({ error: '対象ユーザーが有効ではないため承認できません' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const pendingExists = `EXISTS (SELECT 1 FROM cash_topup_requests WHERE id = ? AND status = 'PENDING')`;
  const stmts: D1PreparedStatement[] = [];

  if (body.status === 'APPROVED') {
    const column = req.currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';
    stmts.push(
      c.env.DB.prepare(
        `UPDATE users SET ${column} = ${column} + ?, updated_at = ? WHERE id = ? AND ${pendingExists}`,
      ).bind(req.amount_c, now, req.user_id, id),
    );
  }
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO admin_audit_log (id, admin_user_id, target_user_id, action, before_value, after_value, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${pendingExists}`,
    ).bind(
      crypto.randomUUID(),
      adminAuth.userId,
      req.user_id,
      body.status === 'APPROVED' ? 'CASH_TOPUP_APPROVE' : 'CASH_TOPUP_REJECT',
      JSON.stringify({ request_id: id, status: 'PENDING' }),
      JSON.stringify({ request_id: id, status: body.status, currency: req.currency, amount_c: req.amount_c }),
      now,
      id,
    ),
    c.env.DB.prepare(
      `UPDATE cash_topup_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'PENDING'`,
    ).bind(body.status, now, adminAuth.userId, id),
  );

  const results = await c.env.DB.batch(stmts);
  const last = results[results.length - 1];
  if ((last?.meta.changes ?? 0) === 0) return c.json({ error: 'すでに処理済みの申請です' }, 409);
  return c.json({ ok: true });
});

export default app;
