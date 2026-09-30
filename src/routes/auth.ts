import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashSessionToken,
} from '../services/crypto';
import { generateCsrfToken } from '../middleware/csrf';
import { verifyTurnstile } from '../services/turnstile';

const app = new Hono<{ Bindings: Env }>();

/**
 * セッションとCSRFトークンを発行してCookieに載せる（login/registerで共用）。
 * CSRFトークンはJS側で読み取ってヘッダーに載せる必要があるためHttpOnlyにしない（ダブルサブミットクッキー方式）。
 */
async function issueSession(c: Context<{ Bindings: Env }>, userId: string, now: number): Promise<string> {
  const token = generateSessionToken();
  const idHash = await hashSessionToken(token);
  const ttlDays = Number(c.env.SESSION_TTL_DAYS || '30');
  const expiresAt = now + ttlDays * 86400;

  await c.env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(idHash, userId, expiresAt, now)
    .run();

  const cookieName = c.env.SESSION_COOKIE_NAME || 'session';
  c.header(
    'Set-Cookie',
    `${cookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlDays * 86400}`,
  );
  const csrfToken = generateCsrfToken();
  c.header(
    'Set-Cookie',
    `csrf_token=${csrfToken}; Secure; SameSite=Lax; Path=/; Max-Age=${ttlDays * 86400}`,
    { append: true },
  );
  return csrfToken;
}

/**
 * POST /api/register
 * 仕様書4.1: Turnstile検証 → 初期資金付与 → ソルト付きハッシュでパスワード保存
 */
app.post('/register', async (c) => {
  const body = await c.req.json<{ username: string; password: string; turnstileToken: string }>();

  const remoteIp = c.req.header('CF-Connecting-IP') ?? undefined;
  const turnstileOk = await verifyTurnstile(c.env, body.turnstileToken, remoteIp);
  if (!turnstileOk) return c.json({ error: 'bot verification failed' }, 400);

  const salt = generateSalt();
  const hash = await hashPassword(body.password, salt);
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, password_salt, password_hash, role, status,
        cash_balance_jpy_c, cash_balance_usd_c, failed_login_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'USER', 'ACTIVE', 100000000, 0, 0, ?, ?)`,
    )
      .bind(id, body.username, salt, hash, now, now)
      .run();
  } catch {
    return c.json({ error: 'username already exists' }, 400);
  }

  // 登録と同時にログイン完了させる（仕様書v0.2: 登録後に再ログインさせない）
  const csrfToken = await issueSession(c, id, now);
  return c.json({ id, username: body.username, csrf_token: csrfToken }, 201);
});

/**
 * POST /api/login
 * 仕様書4.1: Turnstile検証 → lockout判定 → パスワード照合 → HttpOnly Cookie発行
 */
app.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string; turnstileToken: string }>();

  const remoteIp = c.req.header('CF-Connecting-IP') ?? undefined;
  const turnstileOk = await verifyTurnstile(c.env, body.turnstileToken, remoteIp);
  if (!turnstileOk) return c.json({ error: 'bot verification failed' }, 400);

  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE username = ?`)
    .bind(body.username)
    .first<{
      id: string;
      password_salt: string;
      password_hash: string;
      failed_login_attempts: number;
      lockout_until: number | null;
      status: string;
    }>();

  if (!user || user.status !== 'ACTIVE') {
    return c.json({ error: 'invalid credentials' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (user.lockout_until && user.lockout_until > now) {
    return c.json({ error: 'too many attempts' }, 429);
  }

  const ok = await verifyPassword(body.password, user.password_salt, user.password_hash);
  if (!ok) {
    const fails = user.failed_login_attempts + 1;
    const maxFails = Number(c.env.LOGIN_MAX_FAILS || '5');
    const lockoutMinutes = Number(c.env.LOGIN_LOCKOUT_MINUTES || '15');
    const lockoutUntil = fails >= maxFails ? now + lockoutMinutes * 60 : null;
    await c.env.DB.prepare(
      `UPDATE users SET failed_login_attempts = ?, lockout_until = ? WHERE id = ?`,
    )
      .bind(fails, lockoutUntil, user.id)
      .run();
    return c.json({ error: 'invalid credentials' }, 401);
  }

  await c.env.DB.prepare(
    `UPDATE users SET failed_login_attempts = 0, lockout_until = NULL WHERE id = ?`,
  )
    .bind(user.id)
    .run();

  const csrfToken = await issueSession(c, user.id, now);
  return c.json({ ok: true, csrf_token: csrfToken });
});

/** POST /api/logout — 仕様書4.1 */
app.post('/logout', requireCsrf, requireAuth, async (c) => {
  const cookieName = c.env.SESSION_COOKIE_NAME || 'session';
  const cookieHeader = c.req.header('Cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|; )${cookieName}=([^;]+)`));
  if (match?.[1]) {
    const idHash = await hashSessionToken(decodeURIComponent(match[1]));
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(idHash).run();
  }
  c.header('Set-Cookie', `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  c.header('Set-Cookie', `csrf_token=; Secure; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
  return c.json({ ok: true });
});

/**
 * POST /api/account/password — ログイン中ユーザー本人のパスワード変更（仕様書4.1）
 * 忘れた場合のリセットはユーザー自身には提供せず、管理者機能のみで対応する。
 */
app.post('/account/password', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ currentPassword: string; newPassword: string }>();

  const user = await c.env.DB.prepare(
    `SELECT password_salt, password_hash FROM users WHERE id = ?`,
  )
    .bind(auth.userId)
    .first<{ password_salt: string; password_hash: string }>();
  if (!user) return c.json({ error: 'not found' }, 404);

  const ok = await verifyPassword(body.currentPassword, user.password_salt, user.password_hash);
  if (!ok) return c.json({ error: 'current password incorrect' }, 400);

  const newSalt = generateSalt();
  const newHash = await hashPassword(body.newPassword, newSalt);
  await c.env.DB.prepare(
    `UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(newSalt, newHash, Math.floor(Date.now() / 1000), auth.userId)
    .run();

  return c.json({ ok: true });
});

/**
 * POST /api/account/delete — ログイン中ユーザー本人のアカウント削除（仕様書v0.2）
 * パスワード再入力必須。関連データ（保有・注文・両替・セッション等）をまとめて物理削除する。
 * 管理者アカウントは誤削除・監査ログの整合性保護のため、この経路では削除不可。
 */
app.post('/account/delete', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ password: string }>().catch(() => null);
  if (!body || !body.password) return c.json({ error: 'password required' }, 400);

  const user = await c.env.DB.prepare(
    `SELECT password_salt, password_hash, role FROM users WHERE id = ?`,
  )
    .bind(auth.userId)
    .first<{ password_salt: string; password_hash: string; role: string }>();
  if (!user) return c.json({ error: 'not found' }, 404);
  if (user.role === 'ADMIN') return c.json({ error: 'admin account cannot be deleted' }, 403);

  const ok = await verifyPassword(body.password, user.password_salt, user.password_hash);
  if (!ok) return c.json({ error: 'password incorrect' }, 400);

  const uid = auth.userId;
  // 外部キー制約のため子テーブル→usersの順に、1バッチ(トランザクション)で削除する
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(uid),
    c.env.DB.prepare(`DELETE FROM admin_sessions WHERE user_id = ?`).bind(uid),
    c.env.DB.prepare(`DELETE FROM webauthn_credentials WHERE user_id = ?`).bind(uid),
    c.env.DB.prepare(`DELETE FROM admin_audit_log WHERE target_user_id = ?`).bind(uid),
    c.env.DB.prepare(`DELETE FROM fx_transactions WHERE user_id = ?`).bind(uid),
    c.env.DB.prepare(`DELETE FROM orders WHERE user_id = ?`).bind(uid),
    c.env.DB.prepare(`DELETE FROM trades WHERE user_id = ?`).bind(uid),
    c.env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(uid),
  ]);

  const cookieName = c.env.SESSION_COOKIE_NAME || 'session';
  c.header('Set-Cookie', `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  c.header('Set-Cookie', `csrf_token=; Secure; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
  return c.json({ ok: true });
});

export default app;
