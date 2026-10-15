import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import {
  SCOPES,
  CODE_TTL_SECONDS,
  MAX_GRANTS_PER_USER,
  issuerOf,
  hashToken,
  newCode,
  scopeString,
  isLoopbackHost,
  parseAuthorizationRequest,
  errorRedirectUrl,
  revokeGrant,
} from '../services/oauth';

/**
 * 承認画面（/oauth-consent.html）と設定画面「連携アプリ」が使うAPI（仕様書4.17）。
 * いずれもログイン必須。状態を変えるものはCSRFトークンも必須。
 */
const app = new Hono<{ Bindings: Env }>();

function ip(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

/** 戻り先の見せ方（承認画面で警告を出し分けるため） */
function describeRedirect(uri: string): { kind: 'web' | 'loopback' | 'app'; host: string } {
  const u = new URL(uri);
  if (u.protocol === 'https:') return { kind: 'web', host: u.host };
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return { kind: 'loopback', host: u.hostname };
  return { kind: 'app', host: u.protocol.replace(/:$/, '') };
}

/** GET /api/oauth/authorization-info?<認可リクエストのクエリ> — 承認画面に表示する内容。毎回リクエストを再検証する */
app.get('/oauth/authorization-info', requireAuth, async (c) => {
  const auth = c.get('auth');
  const parsed = await parseAuthorizationRequest(c.env, new URL(c.req.url).searchParams, issuerOf(c.req.url), ip(c));
  if (!parsed.ok) return c.json({ error: parsed.error, error_description: parsed.description }, 400);
  const { client, redirectUri, scopes } = parsed.req;

  const user = await c.env.DB.prepare(`SELECT username FROM users WHERE id = ?`).bind(auth.userId).first<{ username: string }>();
  return c.json({
    client: {
      name: client.client_name,
      kind: client.kind,
      // CIMDはclient_idがURLなので、そのホスト名を見せる（名前は自己申告で偽装できるため）
      host: client.kind === 'CIMD' ? new URL(client.client_id).host : null,
    },
    redirect: describeRedirect(redirectUri),
    scopes,
    username: user?.username ?? '',
  });
});

/** POST /api/oauth/decision — 許可／拒否。戻り先URLをJSONで返す（フォーム送信ではCSPのform-actionに止められるため、ブラウザ側でJSから移動する） */
app.post('/oauth/decision', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req
    .json<{ query?: unknown; approved?: unknown; scopes?: unknown }>()
    .catch(() => null);
  if (!body || typeof body.query !== 'string' || body.query.length > 4096 || typeof body.approved !== 'boolean') {
    return c.json({ error: 'invalid body' }, 400);
  }
  const issuer = issuerOf(c.req.url);
  const parsed = await parseAuthorizationRequest(c.env, new URLSearchParams(body.query), issuer, ip(c));
  if (!parsed.ok) return c.json({ error: parsed.error, error_description: parsed.description }, 400);
  const req = parsed.req;

  if (!body.approved) {
    return c.json({ redirect: errorRedirectUrl(req.redirectUri, issuer, 'access_denied', 'the user denied the request', req.state) });
  }

  // 許可する権限は、要求された範囲の中からユーザーが選んだもの
  if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== 'string')) {
    return c.json({ error: 'scopes must be an array' }, 400);
  }
  const chosen = [...new Set(body.scopes as string[])];
  if (!chosen.length) return c.json({ error: 'select at least one permission' }, 400);
  if (chosen.some((s) => !req.scopes.includes(s as (typeof SCOPES)[number]))) {
    return c.json({ error: 'scope was not requested' }, 400);
  }

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(auth.userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_GRANTS_PER_USER) {
    return c.json({ error: `連携できるアプリは${MAX_GRANTS_PER_USER}件までです。設定画面で使わないものを取り消してください` }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const grantId = crypto.randomUUID();
  const code = newCode();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO oauth_grants (id, user_id, client_id, scope, resource, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(grantId, auth.userId, req.client.client_id, scopeString(chosen), req.resource, now),
    c.env.DB.prepare(
      `INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(await hashToken(code), grantId, req.redirectUri, req.codeChallenge, now + CODE_TTL_SECONDS),
  ]);

  const u = new URL(req.redirectUri);
  u.searchParams.set('code', code);
  if (req.state) u.searchParams.set('state', req.state);
  u.searchParams.set('iss', issuer);
  return c.json({ redirect: u.toString() });
});

/** GET /api/oauth/grants — 設定画面の「連携アプリ」。一度でも使われた（認可コードが使われた）有効な許可だけを出す */
app.get('/oauth/grants', requireAuth, async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT g.id AS id, g.scope AS scope, g.activated_at AS connected_at, g.last_used_at AS last_used_at,
            o.client_name AS client_name, o.kind AS kind, o.client_id AS client_id
       FROM oauth_grants g JOIN oauth_clients o ON o.client_id = g.client_id
      WHERE g.user_id = ? AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
      ORDER BY g.activated_at DESC`,
  ).bind(auth.userId).all<{
    id: string; scope: string; connected_at: number; last_used_at: number | null;
    client_name: string; kind: 'DCR' | 'CIMD'; client_id: string;
  }>();
  return c.json({
    mcp_url: `${issuerOf(c.req.url)}/mcp`,
    grants: results.map((g) => ({
      id: g.id,
      client_name: g.client_name,
      host: g.kind === 'CIMD' ? new URL(g.client_id).host : null,
      scopes: g.scope.split(' '),
      connected_at: g.connected_at,
      last_used_at: g.last_used_at,
    })),
  });
});

/** DELETE /api/oauth/grants/:id — 自分の許可だけを取り消す */
app.delete('/oauth/grants/:id', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const row = await c.env.DB.prepare(`SELECT id FROM oauth_grants WHERE id = ? AND user_id = ?`)
    .bind(c.req.param('id'), auth.userId)
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  await revokeGrant(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

export default app;
