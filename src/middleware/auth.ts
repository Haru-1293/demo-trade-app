import type { MiddlewareHandler } from 'hono';
import type { Env, AuthContext, SessionRow, UserRow } from '../types';
import { hashSessionToken } from '../services/crypto';

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** ログイン必須API用ミドルウェア。session cookie を検証し c.set('auth', ...) する */
export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const cookieName = c.env.SESSION_COOKIE_NAME || 'session';
  const token = getCookie(c.req.raw, cookieName);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const idHash = await hashSessionToken(token);
  const session = await c.env.DB.prepare(
    `SELECT * FROM sessions WHERE id_hash = ?`,
  )
    .bind(idHash)
    .first<SessionRow>();

  const now = Math.floor(Date.now() / 1000);
  if (!session || session.expires_at < now) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?`)
    .bind(session.user_id)
    .first<UserRow>();

  if (!user || user.status !== 'ACTIVE') {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('auth', { userId: user.id, role: user.role, status: user.status });
  await next();
};

/** 管理者API用ミドルウェア。requireAuth の後に使う想定 */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.role !== 'ADMIN' || auth.status !== 'ACTIVE') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};
