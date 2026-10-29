import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  hashSessionToken,
} from '../services/crypto';
import { issueSession, loggedInAccounts, writeAccounts, sessionCookieName, candidateTokens, MAX_ACCOUNTS } from '../services/session';
import { verifyTurnstile } from '../services/turnstile';
import { validateUsername, validatePassword } from '../services/validation';

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /api/register
 * 仕様書4.1: Turnstile検証 → 初期資金付与 → ソルト付きハッシュでパスワード保存
 */
app.post('/register', async (c) => {
  const body = await c.req
    .json<{ username: string; password: string; turnstileToken: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  // 形式の検証（Turnstileの前に行い、不正な入力で外部検証を消費しない）
  const inputError = validateUsername(body.username) ?? validatePassword(body.password);
  if (inputError) return c.json({ error: inputError }, 400);

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
  const body = await c.req
    .json<{ username: string; password: string; turnstileToken: string }>()
    .catch(() => null);
  // 型と長さだけ確認する（既存ユーザーの古いユーザー名・パスワードでもログインできるよう、形式の規則は適用しない）
  if (
    !body || typeof body.username !== 'string' || typeof body.password !== 'string' ||
    body.username.length > 200 || body.password.length > 1024
  ) {
    return c.json({ error: 'invalid body' }, 400);
  }

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

/**
 * POST /api/logout — 仕様書4.1 / 4.1.1
 * いま使っているアカウントだけをログアウトする。ほかにログイン中のアカウントがあれば、そのうち先頭のアカウントに切り替える。
 * `{ "all": true }` を渡すと、この端末のすべてのアカウントをログアウトする。
 */
app.post('/logout', requireCsrf, requireAuth, async (c) => {
  const body = await c.req.json<{ all?: boolean }>().catch(() => null);
  const accounts = await loggedInAccounts(c);
  const activeToken = (c.req.header('Cookie') ?? '').match(new RegExp(`(?:^|; )${sessionCookieName(c)}=([^;]+)`))?.[1];
  const targets = body?.all === true ? accounts : accounts.filter((a) => a.token === activeToken);
  for (const a of targets) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await hashSessionToken(a.token)).run();
  }
  const rest = accounts.filter((a) => !targets.includes(a));
  writeAccounts(c, rest);
  return c.json({ ok: true, active_user_id: rest[0]?.userId ?? null });
});

/** GET /api/accounts — この端末でログイン中のアカウント一覧（仕様書4.1.1）。失効したものはここで一覧から外す */
app.get('/accounts', async (c) => {
  const accounts = await loggedInAccounts(c);
  const stale = candidateTokens(c).length !== accounts.length;
  if (stale || !accounts.length) writeAccounts(c, accounts, accounts[0]?.userId);
  const activeToken = (c.req.header('Cookie') ?? '').match(new RegExp(`(?:^|; )${sessionCookieName(c)}=([^;]+)`))?.[1];
  const activeId = accounts.find((a) => a.token === activeToken)?.userId ?? null;
  return c.json({
    accounts: accounts.map((a) => ({ user_id: a.userId, username: a.username, active: a.userId === activeId })),
    max: MAX_ACCOUNTS,
  });
});

/** POST /api/accounts/switch — ログイン中の別のアカウントに切り替える（再ログイン不要。仕様書4.1.1） */
app.post('/accounts/switch', requireCsrf, async (c) => {
  const body = await c.req.json<{ user_id?: string }>().catch(() => null);
  if (!body || typeof body.user_id !== 'string' || body.user_id.length > 100) return c.json({ error: 'invalid body' }, 400);
  const accounts = await loggedInAccounts(c);
  const target = accounts.find((a) => a.userId === body.user_id);
  if (!target) return c.json({ error: 'not logged in as that account' }, 404);
  writeAccounts(c, accounts, target.userId);
  return c.json({ ok: true, user_id: target.userId, username: target.username });
});

/**
 * POST /api/account/password — ログイン中ユーザー本人のパスワード変更（仕様書4.1）
 * 忘れた場合のリセットはユーザー自身には提供せず、管理者機能のみで対応する。
 */
app.post('/account/password', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ currentPassword: string; newPassword: string }>().catch(() => null);
  if (!body || typeof body.currentPassword !== 'string') return c.json({ error: 'invalid body' }, 400);
  const passwordError = validatePassword(body.newPassword);
  if (passwordError) return c.json({ error: passwordError }, 400);

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
 * POST /api/account/delete — ログイン中ユーザー本人のアカウント削除（仕様書7.1.4）
 * パスワード再入力必須。管理者による抹消(4.5)と同じ扱いで status='DELETED' に更新し、全セッションを削除する。
 * 保有株・取引履歴は監査目的で保持し、物理削除はしない。
 * 管理者アカウントは誤削除防止のため、この経路では削除できない。
 */
app.post('/account/delete', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ password: string }>().catch(() => null);
  if (!body || typeof body.password !== 'string' || !body.password) return c.json({ error: 'password required' }, 400);

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
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET status = 'DELETED', updated_at = ? WHERE id = ?`)
      .bind(Math.floor(Date.now() / 1000), uid),
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(uid),
    // 外部アプリ（MCP）への許可も失効する（仕様書4.17）
    c.env.DB.prepare(`DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE user_id = ?)`).bind(uid),
    c.env.DB.prepare(`DELETE FROM oauth_codes WHERE grant_id IN (SELECT id FROM oauth_grants WHERE user_id = ?)`).bind(uid),
    c.env.DB.prepare(`UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
      .bind(Math.floor(Date.now() / 1000), uid),
  ]);

  // 削除したアカウントのセッションはDBから消えているので、残りの有効なアカウントだけをCookieに残す（先頭に切り替わる）
  const rest = await loggedInAccounts(c);
  writeAccounts(c, rest);
  return c.json({ ok: true, active_user_id: rest[0]?.userId ?? null });
});

export default app;
