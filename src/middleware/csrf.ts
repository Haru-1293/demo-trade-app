import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';

/**
 * 仕様書6.: 状態変更を伴うAPIは SameSite=Lax Cookie に加えてCSRFトークン検証を必須とする。
 * ダブルサブミットクッキー方式: ログイン時に csrf_token をJS読み取り可能なCookieとして発行し、
 * 状態変更リクエストでは X-CSRF-Token ヘッダーとCookieの値が一致することを検証する。
 */
export const requireCsrf: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  const header = c.req.header('X-CSRF-Token');
  const cookieHeader = c.req.header('Cookie') ?? '';
  const match = cookieHeader.match(/(?:^|; )csrf_token=([^;]+)/);
  const cookieToken = match ? decodeURIComponent(match[1]) : null;

  if (!header || !cookieToken || header !== cookieToken) {
    return c.json({ error: 'CSRF token mismatch' }, 403);
  }
  await next();
};

export function generateCsrfToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
