import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import {
  SCOPES,
  issuerOf,
  resourceOf,
  sameResource,
  pkceS256,
  hashToken,
  issueTokens,
  revokeGrant,
  parseScopes,
  scopeString,
  parseAuthorizationRequest,
  validateRedirectUri,
  sanitizeClientName,
  getClient,
} from '../services/oauth';
import { generateSessionToken } from '../services/crypto';
import { timingSafeEqualStr } from '../services/validation';

/**
 * OAuth 2.0 認可サーバーの公開エンドポイント（仕様書4.17）。
 * メタデータ(RFC 8414 / 9728)、DCR(RFC 7591)、認可、トークン、取り消し(RFC 7009)。
 */
const app = new Hono<{ Bindings: Env }>();

// 公開エンドポイントは、ブラウザ上のMCPクライアントも読めるようCORSを許可する。
// Cookieもクレデンシャルも使わない（ベアラートークンとPKCEで保護する）ので、ワイルドカードで安全。
app.use('/.well-known/*', corsAnywhere);
app.use('/oauth/*', corsAnywhere);

async function corsAnywhere(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', '*');
}

function clientIp(c: Context<{ Bindings: Env }>): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function oauthError(c: Context<{ Bindings: Env }>, error: string, description: string, status = 400) {
  return c.json({ error, error_description: description }, status as 400, noStore);
}

// ---------- メタデータ ----------
function protectedResourceMetadata(issuer: string) {
  return {
    resource: resourceOf(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'デモトレード',
  };
}
app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(issuerOf(c.req.url))));
app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata(issuerOf(c.req.url))));

function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}
app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(issuerOf(c.req.url))));
app.get('/.well-known/openid-configuration', (c) => c.json(authorizationServerMetadata(issuerOf(c.req.url))));

// ---------- DCR (RFC 7591) ----------
const DCR_PER_IP_PER_HOUR = 10;
const DCR_PER_DAY = 300;

app.post('/oauth/register', async (c) => {
  const text = await c.req.text();
  if (text.length > 10 * 1024) return oauthError(c, 'invalid_client_metadata', 'request body too large');
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return oauthError(c, 'invalid_client_metadata', 'body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError(c, 'invalid_client_metadata', 'body must be a JSON object');

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) {
    return oauthError(c, 'invalid_redirect_uri', 'redirect_uris must contain 1 to 5 entries');
  }
  for (const u of uris) {
    const err = validateRedirectUri(u);
    if (err) return oauthError(c, 'invalid_redirect_uri', err);
  }
  const allowedGrants = ['authorization_code', 'refresh_token'];
  if (body.grant_types !== undefined) {
    if (!Array.isArray(body.grant_types) || body.grant_types.some((g: unknown) => !allowedGrants.includes(g as string))) {
      return oauthError(c, 'invalid_client_metadata', 'grant_types must be authorization_code and/or refresh_token');
    }
  }
  if (body.response_types !== undefined) {
    if (!Array.isArray(body.response_types) || body.response_types.some((t: unknown) => t !== 'code')) {
      return oauthError(c, 'invalid_client_metadata', 'response_types must be ["code"]');
    }
  }
  let clientUri: string | null = null;
  if (typeof body.client_uri === 'string' && body.client_uri.length <= 200) {
    try {
      if (new URL(body.client_uri).protocol === 'https:') clientUri = body.client_uri;
    } catch {
      /* 無効なら保存しない */
    }
  }

  // 濫用対策: IP単位・サイト全体の件数制限（D1で数えるので厳密）。IPそのものは保存しない
  const now = Math.floor(Date.now() / 1000);
  const ipHash = await hashToken(`ip:${clientIp(c)}`);
  const perIp = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM oauth_clients WHERE kind = 'DCR' AND registered_ip_hash = ? AND created_at > ?`,
  ).bind(ipHash, now - 3600).first<{ n: number }>();
  const perDay = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM oauth_clients WHERE kind = 'DCR' AND created_at > ?`,
  ).bind(now - 86400).first<{ n: number }>();
  if ((perIp?.n ?? 0) >= DCR_PER_IP_PER_HOUR || (perDay?.n ?? 0) >= DCR_PER_DAY) {
    return c.json({ error: 'temporarily_unavailable', error_description: 'too many registrations, try again later' }, 429, {
      ...noStore,
      'Retry-After': '3600',
    });
  }

  const clientId = `mcp_${generateSessionToken().slice(0, 32)}`;
  const name = sanitizeClientName(body.client_name);
  await c.env.DB.prepare(
    `INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris, client_uri, registered_ip_hash, created_at, fetched_at)
     VALUES (?, 'DCR', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(clientId, name, JSON.stringify(uris), clientUri, ipHash, now, now)
    .run();

  return c.json(
    {
      client_id: clientId,
      client_id_issued_at: now,
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // 要求が何であっても、公開クライアントとして登録する（RFC 7591）
    },
    201,
    noStore,
  );
});

// ---------- 認可 ----------
function errorPage(message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="ja"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>デモトレード</title><link rel="stylesheet" href="/styles.css" /></head>
<body><div id="app"><div class="consent-screen"><h2>接続できませんでした</h2>
<div class="consent-error">${esc(message)}</div>
<p class="muted-text">接続を始めたアプリに戻って、もう一度お試しください。</p></div></div></body></html>`;
}

app.get('/oauth/authorize', async (c) => {
  const issuer = issuerOf(c.req.url);
  const url = new URL(c.req.url);
  const parsed = await parseAuthorizationRequest(c.env, url.searchParams, issuer, clientIp(c));
  if (!parsed.ok) {
    // client_id・redirect_uri が信頼できないときは戻り先へ飛ばさず、ここにエラーを出す（オープンリダイレクト防止）
    if (parsed.redirectTo) return c.redirect(parsed.redirectTo, 302);
    return c.html(errorPage(`${parsed.error}: ${parsed.description}`), 400);
  }
  // 受け取ったクエリをそのまま承認画面へ引き継ぐ。サーバーには承認待ちの状態を保存しない
  return c.redirect(`/oauth-consent.html${url.search}`, 302);
});

// ---------- トークン ----------
async function readForm(c: Context<{ Bindings: Env }>): Promise<URLSearchParams | null> {
  const text = await c.req.text();
  if (text.length > 8 * 1024) return null;
  return new URLSearchParams(text);
}

app.post('/oauth/token', async (c) => {
  const form = await readForm(c);
  if (!form) return oauthError(c, 'invalid_request', 'request too large');
  const grantType = form.get('grant_type');
  const clientId = form.get('client_id') ?? '';
  if (!clientId) return oauthError(c, 'invalid_client', 'client_id is required');
  const client = await getClient(c.env, clientId, clientIp(c));
  if (!client) return oauthError(c, 'invalid_client', 'unknown or invalid client_id');
  const issuer = issuerOf(c.req.url);
  const resource = resourceOf(issuer);
  for (const r of form.getAll('resource')) {
    if (!sameResource(r, resource)) return oauthError(c, 'invalid_target', `resource must be ${resource}`);
  }
  const now = Math.floor(Date.now() / 1000);

  if (grantType === 'authorization_code') {
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    if (!code || code.length > 200) return oauthError(c, 'invalid_request', 'code is required');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError(c, 'invalid_request', 'code_verifier is required (43-128 characters)');

    const codeHash = await hashToken(code);
    const row = await c.env.DB.prepare(
      `SELECT c.grant_id AS grant_id, c.redirect_uri AS redirect_uri, c.code_challenge AS code_challenge,
              c.expires_at AS expires_at, c.used_at AS used_at,
              g.client_id AS client_id, g.scope AS scope, g.resource AS resource, g.revoked_at AS revoked_at
         FROM oauth_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = ?`,
    ).bind(codeHash).first<{
      grant_id: string; redirect_uri: string; code_challenge: string; expires_at: number; used_at: number | null;
      client_id: string; scope: string; resource: string; revoked_at: number | null;
    }>();
    if (!row || row.revoked_at) return oauthError(c, 'invalid_grant', 'invalid authorization code');

    // 使用済みのコードが再び来た＝盗まれた可能性があるため、その許可を丸ごと失効する
    if (row.used_at) {
      await revokeGrant(c.env, row.grant_id);
      return oauthError(c, 'invalid_grant', 'authorization code already used');
    }
    // 検証の前に使用済みにする（verifierの総当たりをさせない）。同時に2回来ても片方だけが通る
    const used = await c.env.DB.prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`)
      .bind(now, codeHash).run();
    if ((used.meta.changes ?? 0) === 0) {
      await revokeGrant(c.env, row.grant_id);
      return oauthError(c, 'invalid_grant', 'authorization code already used');
    }
    if (row.expires_at < now) return oauthError(c, 'invalid_grant', 'authorization code expired');
    if (row.client_id !== client.client_id) return oauthError(c, 'invalid_grant', 'code was issued to a different client');
    if (row.redirect_uri !== redirectUri) return oauthError(c, 'invalid_grant', 'redirect_uri does not match the authorization request');
    if (!timingSafeEqualStr(await pkceS256(verifier), row.code_challenge)) {
      return oauthError(c, 'invalid_grant', 'PKCE verification failed');
    }
    if (!sameResource(row.resource, resource)) return oauthError(c, 'invalid_target', 'grant was issued for a different resource');

    const tokens = await issueTokens(c.env, row.grant_id, row.scope, [
      c.env.DB.prepare(`UPDATE oauth_grants SET activated_at = COALESCE(activated_at, ?) WHERE id = ?`).bind(now, row.grant_id),
    ]);
    return c.json({ ...tokens, token_type: 'Bearer', scope: row.scope }, 200, noStore);
  }

  if (grantType === 'refresh_token') {
    const refresh = form.get('refresh_token') ?? '';
    if (!refresh.startsWith('dtr_') || refresh.length > 200) return oauthError(c, 'invalid_grant', 'invalid refresh token');
    const hash = await hashToken(refresh);
    const row = await c.env.DB.prepare(
      `SELECT t.grant_id AS grant_id, t.scope AS scope, t.expires_at AS expires_at, t.used_at AS used_at,
              g.client_id AS client_id, g.revoked_at AS revoked_at, g.resource AS resource, u.status AS user_status
         FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.token_hash = ? AND t.kind = 'REFRESH'`,
    ).bind(hash).first<{
      grant_id: string; scope: string; expires_at: number; used_at: number | null;
      client_id: string; revoked_at: number | null; resource: string; user_status: string;
    }>();
    if (!row || row.revoked_at || row.client_id !== client.client_id) return oauthError(c, 'invalid_grant', 'invalid refresh token');

    // ローテーション済みのリフレッシュトークンが再び来た＝盗まれた可能性があるため、許可を丸ごと失効する（公開クライアントの必須要件）
    if (row.used_at) {
      await revokeGrant(c.env, row.grant_id);
      return oauthError(c, 'invalid_grant', 'refresh token already used');
    }
    if (row.expires_at < now) return oauthError(c, 'invalid_grant', 'refresh token expired');
    if (row.user_status !== 'ACTIVE') return oauthError(c, 'invalid_grant', 'account is not active');
    if (!sameResource(row.resource, resource)) return oauthError(c, 'invalid_target', 'grant was issued for a different resource');

    // 権限は元のトークンの範囲内でのみ縮小できる
    let scope = row.scope;
    const requested = form.get('scope');
    if (requested) {
      const p = parseScopes(requested);
      if ('error' in p) return oauthError(c, 'invalid_scope', p.error);
      const have = new Set(row.scope.split(' '));
      if (p.scopes.some((s) => !have.has(s))) return oauthError(c, 'invalid_scope', 'cannot widen the scope');
      scope = scopeString(p.scopes);
    }

    const used = await c.env.DB.prepare(`UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`)
      .bind(now, hash).run();
    if ((used.meta.changes ?? 0) === 0) {
      await revokeGrant(c.env, row.grant_id);
      return oauthError(c, 'invalid_grant', 'refresh token already used');
    }
    const tokens = await issueTokens(c.env, row.grant_id, scope);
    return c.json({ ...tokens, token_type: 'Bearer', scope }, 200, noStore);
  }

  return oauthError(c, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
});

// ---------- 取り消し (RFC 7009) ----------
app.post('/oauth/revoke', async (c) => {
  const form = await readForm(c);
  const token = form?.get('token') ?? '';
  const clientId = form?.get('client_id') ?? '';
  // 存在しないトークンでも200を返す（RFC 7009）。client_idが一致するトークンだけを失効する
  if (token && clientId && token.length <= 200) {
    const row = await c.env.DB.prepare(
      `SELECT g.id AS grant_id, g.client_id AS client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?`,
    ).bind(await hashToken(token)).first<{ grant_id: string; client_id: string }>();
    if (row && row.client_id === clientId) await revokeGrant(c.env, row.grant_id);
  }
  return c.json({}, 200, noStore);
});

export default app;
