import { Hono } from 'hono';
import type { Env, UserRow, WebauthnCredentialRow } from '../types';
import { verifyTurnstile } from '../services/turnstile';
import { verifyPassword, generateSessionToken, hashSessionToken } from '../services/crypto';
import { generateCsrfToken } from '../middleware/csrf';
import { requireAdminSession, requireAdminCsrf } from '../middleware/adminAuth';
import {
  createRegistrationOptions,
  verifyRegistration,
  createAuthenticationOptions,
  verifyAuthentication,
} from '../services/webauthn';

const app = new Hono<{ Bindings: Env }>();

async function issueAdminSession(c: any, userId: string) {
  const token = generateSessionToken();
  const idHash = await hashSessionToken(token);
  const ttlDays = Number(c.env.ADMIN_SESSION_TTL_DAYS || '1');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlDays * 86400;

  await c.env.DB.prepare(
    `INSERT INTO admin_sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(idHash, userId, expiresAt, now)
    .run();

  const cookieName = c.env.ADMIN_SESSION_COOKIE_NAME || 'admin_session';
  c.header(
    'Set-Cookie',
    `${cookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlDays * 86400}`,
  );
  const csrfToken = generateCsrfToken();
  c.header(
    'Set-Cookie',
    `admin_csrf_token=${csrfToken}; Secure; SameSite=Lax; Path=/; Max-Age=${ttlDays * 86400}`,
    { append: true },
  );
  return csrfToken;
}

/**
 * POST /api/admin-auth/login — メールアドレス+パスワードでの管理画面ログイン。
 * 通常アプリのログイン(username+password)とは別の独立したセッションを発行する（仕様書4.5.1）。
 * ロックアウト・失敗回数は users テーブルを共有（同一アカウントのため）。
 */
app.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string; turnstileToken: string }>();

  const remoteIp = c.req.header('CF-Connecting-IP') ?? undefined;
  const turnstileOk = await verifyTurnstile(c.env, body.turnstileToken, remoteIp);
  if (!turnstileOk) return c.json({ error: 'bot verification failed' }, 400);

  const user = await c.env.DB.prepare(
    `SELECT * FROM users WHERE email = ? AND role = 'ADMIN'`,
  )
    .bind(body.email)
    .first<UserRow>();

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
    await c.env.DB.prepare(`UPDATE users SET failed_login_attempts = ?, lockout_until = ? WHERE id = ?`)
      .bind(fails, lockoutUntil, user.id)
      .run();
    return c.json({ error: 'invalid credentials' }, 401);
  }

  await c.env.DB.prepare(`UPDATE users SET failed_login_attempts = 0, lockout_until = NULL WHERE id = ?`)
    .bind(user.id)
    .run();

  const csrfToken = await issueAdminSession(c, user.id);
  return c.json({ ok: true, csrf_token: csrfToken });
});

/** POST /api/admin-auth/logout */
app.post('/logout', requireAdminCsrf, requireAdminSession, async (c) => {
  const cookieName = c.env.ADMIN_SESSION_COOKIE_NAME || 'admin_session';
  const cookieHeader = c.req.header('Cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|; )${cookieName}=([^;]+)`));
  if (match?.[1]) {
    const idHash = await hashSessionToken(decodeURIComponent(match[1]));
    await c.env.DB.prepare(`DELETE FROM admin_sessions WHERE id_hash = ?`).bind(idHash).run();
  }
  c.header('Set-Cookie', `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  c.header('Set-Cookie', `admin_csrf_token=; Secure; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
  return c.json({ ok: true });
});

/**
 * POST /api/admin-auth/webauthn/register-options
 * パスキー登録の開始。既にメール+パスワードでログイン済み(requireAdminSession)であることが前提。
 */
app.post('/webauthn/register-options', requireAdminSession, async (c) => {
  const adminAuth = c.get('adminAuth');
  const user = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`)
    .bind(adminAuth.userId)
    .first<{ email: string | null }>();
  if (!user?.email) {
    return c.json({ error: 'パスキー登録にはメールアドレスの登録が先に必要です' }, 400);
  }

  const { results: existing } = await c.env.DB.prepare(
    `SELECT * FROM webauthn_credentials WHERE user_id = ?`,
  )
    .bind(adminAuth.userId)
    .all<WebauthnCredentialRow>();

  const options = await createRegistrationOptions(c.env, adminAuth.userId, user.email, existing ?? []);
  return c.json(options);
});

/** POST /api/admin-auth/webauthn/register-verify */
app.post('/webauthn/register-verify', requireAdminCsrf, requireAdminSession, async (c) => {
  const adminAuth = c.get('adminAuth');
  const body = await c.req.json<{ credential: any; label?: string }>();

  const result = await verifyRegistration(c.env, adminAuth.userId, body.credential);
  if (!result.verified || !result.credentialId || !result.publicKeyB64url) {
    return c.json({ error: 'verification failed' }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      adminAuth.userId,
      result.credentialId,
      result.publicKeyB64url,
      result.counter ?? 0,
      result.transports ? JSON.stringify(result.transports) : null,
      body.label ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();

  return c.json({ ok: true });
});

/**
 * POST /api/admin-auth/webauthn/login-options
 * body: { email } — 対象アカウントに登録済みのパスキーに限定した認証オプションを返す。
 */
app.post('/webauthn/login-options', async (c) => {
  const body = await c.req.json<{ email: string }>();
  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ? AND role = 'ADMIN'`)
    .bind(body.email)
    .first<{ id: string }>();
  if (!user) return c.json({ error: 'not found' }, 404);

  const { results: creds } = await c.env.DB.prepare(
    `SELECT * FROM webauthn_credentials WHERE user_id = ?`,
  )
    .bind(user.id)
    .all<WebauthnCredentialRow>();
  if (!creds || creds.length === 0) {
    return c.json({ error: 'このアカウントにはパスキーが登録されていません' }, 400);
  }

  const options = await createAuthenticationOptions(c.env, user.id, creds);
  return c.json({ options, userId: user.id });
});

/** POST /api/admin-auth/webauthn/login-verify — body: { userId, credential } */
app.post('/webauthn/login-verify', async (c) => {
  const body = await c.req.json<{ userId: string; credential: any }>();

  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ? AND role = 'ADMIN'`)
    .bind(body.userId)
    .first<UserRow>();
  if (!user || user.status !== 'ACTIVE') return c.json({ error: 'invalid' }, 401);

  const stored = await c.env.DB.prepare(`SELECT * FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?`)
    .bind(body.credential?.id, body.userId)
    .first<WebauthnCredentialRow>();
  if (!stored) return c.json({ error: 'invalid credential' }, 401);

  const result = await verifyAuthentication(c.env, body.userId, body.credential, stored);
  if (!result.verified) return c.json({ error: 'verification failed' }, 401);

  await c.env.DB.prepare(`UPDATE webauthn_credentials SET counter = ? WHERE id = ?`)
    .bind(result.newCounter ?? stored.counter, stored.id)
    .run();

  const csrfToken = await issueAdminSession(c, body.userId);
  return c.json({ ok: true, csrf_token: csrfToken });
});

export default app;
