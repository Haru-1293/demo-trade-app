import type { Context } from 'hono';
import type { Env } from '../types';
import { generateSessionToken, hashSessionToken } from './crypto';
import { generateCsrfToken } from '../middleware/csrf';

/**
 * セッションとCSRFトークンを発行してCookieに載せる（login/registerで共用）。
 * CSRFトークンはJS側で読み取ってヘッダーに載せる必要があるためHttpOnlyにしない（ダブルサブミットクッキー方式）。
 */
export async function issueSession(c: Context<{ Bindings: Env }>, userId: string, now: number): Promise<string> {
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
