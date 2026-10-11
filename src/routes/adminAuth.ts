import { Hono } from 'hono';
import type { Env, UserRow, WebauthnCredentialRow } from '../types';
import { verifyTurnstile } from '../services/turnstile';
import { verifyPassword, generateSessionToken, hashSessionToken } from '../services/crypto';
import { generateCsrfToken } from '../middleware/csrf';
import { requireAdminSession, requireAdminCsrf } from '../middleware/adminAuth';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  webauthnConfigError,
  createUserRegistrationOptions,
  verifyUserRegistration,
  createUsernamelessAuthOptions,
  extractClientDataChallenge,
  consumeAuthChallenge,
  verifyUserAuthentication,
  TooManyChallengesError,
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
  const body = await c.req
    .json<{ email: string; password: string; turnstileToken: string }>()
    .catch(() => null);
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string' || body.password.length > 1024) {
    return c.json({ error: 'invalid body' }, 400);
  }

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

const MAX_ADMIN_PASSKEYS = 10;
const MAX_LABEL_LENGTH = 60;

function base64urlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
}

/**
 * POST /api/admin-auth/webauthn/register-options
 * パスキー登録の開始。既にログイン済み(requireAdminSession)であることが前提。
 * 標準ユーザー用と同じく discoverable credential（ID入力なしでログイン可能）で登録する。
 */
app.post('/webauthn/register-options', requireAdminCsrf, requireAdminSession, async (c) => {
  const configError = webauthnConfigError(c.env);
  if (configError) return c.json({ error: configError }, 503);
  const adminAuth = c.get('adminAuth');
  const user = await c.env.DB.prepare(`SELECT id, username FROM users WHERE id = ? AND role = 'ADMIN'`)
    .bind(adminAuth.userId)
    .first<{ id: string; username: string }>();
  if (!user) return c.json({ error: 'not found' }, 404);

  const { results: existing } = await c.env.DB.prepare(
    `SELECT * FROM webauthn_credentials WHERE user_id = ? AND scope = 'ADMIN'`,
  )
    .bind(user.id)
    .all<WebauthnCredentialRow>();
  if ((existing ?? []).length >= MAX_ADMIN_PASSKEYS) {
    return c.json({ error: `登録できるパスキーは${MAX_ADMIN_PASSKEYS}件までです` }, 400);
  }

  try {
    return c.json(await createUserRegistrationOptions(c.env, user, existing ?? [], 'ADMIN'));
  } catch (e) {
    return c.json({ error: 'registration options generation failed', detail: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** POST /api/admin-auth/webauthn/register-verify — body: { credential, label? } */
app.post('/webauthn/register-verify', requireAdminCsrf, requireAdminSession, async (c) => {
  const configError = webauthnConfigError(c.env);
  if (configError) return c.json({ error: configError }, 503);
  const adminAuth = c.get('adminAuth');
  const body = await c.req.json<{ credential: any; label?: string }>().catch(() => null);
  if (!body || !body.credential) return c.json({ error: 'credential required' }, 400);

  const result = await verifyUserRegistration(c.env, adminAuth.userId, body.credential);
  if (!result.verified) {
    return c.json({ error: 'verification failed', detail: result.error }, 400);
  }

  const label = (body.label ?? '').toString().trim().slice(0, MAX_LABEL_LENGTH) || null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, label, created_at, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ADMIN')`,
    )
      .bind(
        crypto.randomUUID(),
        adminAuth.userId,
        result.credentialId,
        result.publicKeyB64url,
        result.counter ?? 0,
        result.transports ? JSON.stringify(result.transports) : null,
        label,
        Math.floor(Date.now() / 1000),
      )
      .run();
  } catch {
    return c.json({ error: 'このパスキーはすでに登録されています' }, 409);
  }
  return c.json({ ok: true }, 201);
});

/** GET /api/admin-auth/webauthn/credentials — 管理画面用パスキーの一覧 */
app.get('/webauthn/credentials', requireAdminSession, async (c) => {
  const adminAuth = c.get('adminAuth');
  const { results } = await c.env.DB.prepare(
    `SELECT id, label, created_at, last_used_at FROM webauthn_credentials
     WHERE user_id = ? AND scope = 'ADMIN' ORDER BY created_at DESC`,
  )
    .bind(adminAuth.userId)
    .all();
  return c.json({ credentials: results });
});

/** DELETE /api/admin-auth/webauthn/credentials/:id — 自分の管理画面用パスキーを削除（メール+パスワードでのログインは常に可能） */
app.delete('/webauthn/credentials/:id', requireAdminCsrf, requireAdminSession, async (c) => {
  const adminAuth = c.get('adminAuth');
  const res = await c.env.DB.prepare(
    `DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ? AND scope = 'ADMIN'`,
  )
    .bind(c.req.param('id'), adminAuth.userId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

/**
 * POST /api/admin-auth/webauthn/login-options — メールアドレス不要のパスキーログイン開始。
 * allowCredentials を指定しないため、端末に保存されたパスキーから選んで認証できる。
 */
app.post('/webauthn/login-options', async (c) => {
  const configError = webauthnConfigError(c.env);
  if (configError) return c.json({ error: configError }, 503);
  try {
    return c.json(await createUsernamelessAuthOptions(c.env));
  } catch (e) {
    if (e instanceof TooManyChallengesError) return c.json({ error: 'しばらくしてからもう一度お試しください' }, 429);
    return c.json({ error: 'failed to create options', detail: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** POST /api/admin-auth/webauthn/login-verify — body: { credential } */
app.post('/webauthn/login-verify', async (c) => {
  const configError = webauthnConfigError(c.env);
  if (configError) return c.json({ error: configError }, 503);
  const fail = (detail: string) => c.json({ error: 'パスキーでログインできませんでした', detail }, 401);

  const body = await c.req.json<{ credential: AuthenticationResponseJSON }>().catch(() => null);
  const credential = body?.credential;
  if (!credential || typeof credential.id !== 'string' || !credential.response) return fail('invalid body');

  const challenge = extractClientDataChallenge(credential);
  if (!challenge || !(await consumeAuthChallenge(c.env, challenge))) return fail('challenge expired or not found');

  // 管理画面用(scope='ADMIN')のパスキーだけが対象。標準ユーザー用のパスキーでは管理画面に入れない
  const stored = await c.env.DB.prepare(`SELECT * FROM webauthn_credentials WHERE credential_id = ? AND scope = 'ADMIN'`)
    .bind(credential.id)
    .first<WebauthnCredentialRow>();
  if (!stored) return fail('unknown credential');

  const userHandle = credential.response.userHandle;
  if (userHandle && base64urlToString(userHandle) !== stored.user_id) return fail('user handle mismatch');

  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ? AND role = 'ADMIN'`)
    .bind(stored.user_id)
    .first<UserRow>();
  if (!user || user.status !== 'ACTIVE') return fail('account is not active');

  const result = await verifyUserAuthentication(c.env, challenge, credential, stored);
  if (!result.verified) return fail(result.error ?? 'verification failed');

  await c.env.DB.prepare(`UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?`)
    .bind(result.newCounter ?? stored.counter, Math.floor(Date.now() / 1000), stored.id)
    .run();

  const csrfToken = await issueAdminSession(c, user.id);
  return c.json({ ok: true, csrf_token: csrfToken });
});

export default app;
