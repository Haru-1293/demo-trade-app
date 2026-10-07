import { timingSafeEqualStr } from '../services/validation';
import type { MiddlewareHandler } from 'hono';
import type { Env, AdminAuthContext, AdminSessionRow, UserRow } from '../types';
import { hashSessionToken } from '../services/crypto';

declare module 'hono' {
  interface ContextVariableMap {
    adminAuth: AdminAuthContext;
  }
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * 管理画面専用のセッション検証ミドルウェア。
 * 通常アプリの `sessions`/`session` Cookie とは完全に独立した
 * `admin_sessions`/`admin_session` Cookie を使う（仕様書4.5.1）。
 * role==='ADMIN' かつ status==='ACTIVE' も改めて検証する
 * （ログイン後に凍結・降格された場合に即座に弾くため）。
 */
export const requireAdminSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const cookieName = c.env.ADMIN_SESSION_COOKIE_NAME || 'admin_session';
  const token = getCookie(c.req.raw, cookieName);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const idHash = await hashSessionToken(token);
  const session = await c.env.DB.prepare(`SELECT * FROM admin_sessions WHERE id_hash = ?`)
    .bind(idHash)
    .first<AdminSessionRow>();

  const now = Math.floor(Date.now() / 1000);
  if (!session || session.expires_at < now) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?`)
    .bind(session.user_id)
    .first<UserRow>();

  if (!user || user.role !== 'ADMIN' || user.status !== 'ACTIVE') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  c.set('adminAuth', { userId: user.id });
  await next();
};

/** 管理画面用のダブルサブミットクッキー方式CSRF検証（`admin_csrf_token`、通常アプリの`csrf_token`とは別物） */
export const requireAdminCsrf: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  const header = c.req.header('X-Admin-CSRF-Token');
  const cookieToken = getCookie(c.req.raw, 'admin_csrf_token');
  if (!header || !cookieToken || !timingSafeEqualStr(header, cookieToken)) {
    return c.json({ error: 'CSRF token mismatch' }, 403);
  }
  await next();
};
