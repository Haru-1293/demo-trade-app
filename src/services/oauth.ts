import type { Env } from '../types';
import { generateSessionToken, hashSessionToken } from './crypto';

/**
 * OAuth 2.0 認可サーバーの共通処理（仕様書4.17）。
 * ルートは routes/oauth.ts（公開）と routes/oauthApi.ts（承認画面・要ログイン）。
 */

// ---------- スコープ ----------
export const SCOPES = ['portfolio:read', 'market:read', 'trade:write'] as const;
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_SCOPES: Scope[] = ['portfolio:read', 'market:read'];

/** 空白区切りのscopeを検証する。省略時は読み取り2種。offline_access は（常にリフレッシュトークンを出すため）黙って無視する */
export function parseScopes(raw: string | null | undefined): { scopes: Scope[] } | { error: string } {
  const parts = (raw ?? '').split(/\s+/).filter((s) => s && s !== 'offline_access');
  if (!parts.length) return { scopes: [...DEFAULT_SCOPES] };
  const out: Scope[] = [];
  for (const p of parts) {
    if (!(SCOPES as readonly string[]).includes(p)) return { error: `unknown scope: ${p.slice(0, 50)}` };
    if (!out.includes(p as Scope)) out.push(p as Scope);
  }
  return { scopes: out };
}

export function scopeString(scopes: Iterable<string>): string {
  const set = new Set(scopes);
  return SCOPES.filter((s) => set.has(s)).join(' ');
}

// ---------- 識別子 ----------
export function issuerOf(requestUrl: string): string {
  return new URL(requestUrl).origin;
}
export function resourceOf(issuer: string): string {
  return `${issuer}/mcp`;
}
/** resource指定の比較用（末尾スラッシュの有無だけ許容する） */
export function sameResource(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

export const newCode = () => `dtc_${generateSessionToken()}`;
export const newAccessToken = () => `dta_${generateSessionToken()}`;
export const newRefreshToken = () => `dtr_${generateSessionToken()}`;
export const hashToken = hashSessionToken;

// ---------- 大まかなレート制限（Workerインスタンス内のメモリ） ----------
// 分散環境では厳密でないが、暴走・ループの抑止には十分（厳密な制限が必要な注文はD1で数える）。
const buckets = new Map<string, { n: number; reset: number }>();
export function memoryRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    if (buckets.size > 5000) buckets.clear();
  }
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  b.n += 1;
  return b.n <= limit;
}

// ---------- 表示名・URI ----------
/** 自己申告の表示名を、制御文字・双方向制御文字を除いて100文字までにする */
export function sanitizeClientName(v: unknown): string {
  if (typeof v !== 'string') return 'MCP Client';
  const cleaned = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || 'MCP Client';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BLOCKED_SCHEMES = new Set([
  'javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:', 'mailto:', 'tel:',
]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** 戻り先URIとして登録してよいか。問題があればエラー文を返す */
export function validateRedirectUri(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri || uri.length > 512) return 'redirect_uri is invalid';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(uri)) return 'redirect_uri must not contain whitespace or control characters';
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'redirect_uri is not a valid URI';
  }
  if (uri.includes('#') || u.hash) return 'redirect_uri must not contain a fragment';
  if (u.username || u.password) return 'redirect_uri must not contain user information';
  if (BLOCKED_SCHEMES.has(u.protocol)) return `redirect_uri scheme not allowed: ${u.protocol}`;
  if (u.protocol === 'https:') return u.hostname ? null : 'redirect_uri host is missing';
  if (u.protocol === 'http:') {
    return isLoopbackHost(u.hostname) ? null : 'http redirect_uri is only allowed for loopback (localhost, 127.0.0.1, [::1])';
  }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(u.protocol)) return 'redirect_uri scheme is invalid';
  return null; // アプリ独自スキーム（cursor:// など）
}

/** 認可リクエストのredirect_uriが登録済みのものと一致するか。完全一致。ループバックのhttpだけポート違いを許可する（RFC 8252） */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (r.protocol !== 'http:' || !isLoopbackHost(r.hostname)) return false;
  return registered.some((reg) => {
    try {
      const g = new URL(reg);
      return g.protocol === 'http:' && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
    } catch {
      return false;
    }
  });
}

// ---------- クライアント ----------
export interface ClientRow {
  client_id: string;
  kind: 'DCR' | 'CIMD';
  client_name: string;
  redirect_uris: string[];
  client_uri: string | null;
}

interface ClientDbRow {
  client_id: string;
  kind: 'DCR' | 'CIMD';
  client_name: string;
  redirect_uris: string;
  client_uri: string | null;
  fetched_at: number;
}

function toClient(r: ClientDbRow): ClientRow {
  let uris: string[] = [];
  try {
    const parsed = JSON.parse(r.redirect_uris);
    if (Array.isArray(parsed)) uris = parsed.filter((x) => typeof x === 'string');
  } catch {
    /* 壊れた行は戻り先なし＝どの認可も通らない */
  }
  return { client_id: r.client_id, kind: r.kind, client_name: r.client_name, redirect_uris: uris, client_uri: r.client_uri };
}

const CIMD_FRESH_SECONDS = 3600;
const CIMD_STALE_OK_SECONDS = 86400;
const CIMD_MAX_BYTES = 16 * 1024;

/** CIMDのclient_idとして使ってよいURLか（SSRF・なりすましの入口を絞る） */
export function validateCimdUrl(clientId: string): URL | null {
  if (clientId.length > 512) return null;
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.hash || clientId.includes('#')) return null;
  if (u.port && u.port !== '443') return null;
  if (u.pathname === '/' || u.pathname === '') return null; // パスが必須
  if (/(^|\/)\.{1,2}(\/|$)/.test(clientId.slice(clientId.indexOf('//') + 2))) return null; // . / .. セグメント
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null; // IPアドレス直指定
  if (!host.includes('.')) return null;
  if (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    host.endsWith('.lan') || host.endsWith('.home.arpa') || host.endsWith('.localdomain')
  ) return null;
  return u;
}

async function readLimited(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

interface CimdDoc {
  client_name: string;
  redirect_uris: string[];
  client_uri: string | null;
}

/** CIMDの文書を取得して検証する。失敗はnull（エラー文書は保存しない） */
async function fetchCimd(clientId: string): Promise<CimdDoc | null> {
  let res: Response;
  try {
    res = await fetch(clientId, {
      headers: { Accept: 'application/json' },
      redirect: 'manual', // リダイレクト先への誘導（SSRF・なりすまし）を許さない
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  if (!(res.headers.get('Content-Type') ?? '').toLowerCase().includes('json')) return null;
  const text = await readLimited(res, CIMD_MAX_BYTES);
  if (text === null) return null;
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (doc.client_id !== clientId) return null; // URLと完全一致
  if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) return null;
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) return null;
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') return null;
  const allowedGrants = ['authorization_code', 'refresh_token'];
  if (doc.grant_types !== undefined) {
    if (!Array.isArray(doc.grant_types) || doc.grant_types.some((g: unknown) => !allowedGrants.includes(g as string))) return null;
  }
  if (doc.response_types !== undefined) {
    if (!Array.isArray(doc.response_types) || doc.response_types.some((t: unknown) => t !== 'code')) return null;
  }
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10) return null;
  if (uris.some((u: unknown) => validateRedirectUri(u) !== null)) return null;
  let clientUri: string | null = null;
  if (typeof doc.client_uri === 'string' && doc.client_uri.length <= 200) {
    try {
      if (new URL(doc.client_uri).protocol === 'https:') clientUri = doc.client_uri;
    } catch {
      /* 無効なら表示しない */
    }
  }
  return { client_name: sanitizeClientName(doc.client_name), redirect_uris: uris as string[], client_uri: clientUri };
}

/** client_idからクライアントを解決する。見つからない・検証に通らない場合はnull */
export async function getClient(env: Env, clientId: string, ip: string): Promise<ClientRow | null> {
  if (!clientId || clientId.length > 512) return null;
  const now = Math.floor(Date.now() / 1000);

  if (/^https:\/\//i.test(clientId)) {
    if (!validateCimdUrl(clientId)) return null;
    const row = await env.DB.prepare(`SELECT * FROM oauth_clients WHERE client_id = ? AND kind = 'CIMD'`)
      .bind(clientId)
      .first<ClientDbRow>();
    if (row && row.fetched_at > now - CIMD_FRESH_SECONDS) return toClient(row);

    // 取得の連打（他人のサーバーへ送らせる踏み台）を抑える
    if (memoryRateLimit(`cimd:${ip}`, 20, 60_000)) {
      const doc = await fetchCimd(clientId);
      if (doc) {
        await env.DB.prepare(
          `INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris, client_uri, created_at, fetched_at)
           VALUES (?, 'CIMD', ?, ?, ?, ?, ?)
           ON CONFLICT(client_id) DO UPDATE SET client_name = excluded.client_name,
             redirect_uris = excluded.redirect_uris, client_uri = excluded.client_uri, fetched_at = excluded.fetched_at`,
        )
          .bind(clientId, doc.client_name, JSON.stringify(doc.redirect_uris), doc.client_uri, now, now)
          .run();
        return { client_id: clientId, kind: 'CIMD', client_name: doc.client_name, redirect_uris: doc.redirect_uris, client_uri: doc.client_uri };
      }
    }
    // 取得に失敗しても、直近24時間以内に検証済みの内容があればそれを使う（一時的な障害で連携が止まらないように）
    if (row && row.fetched_at > now - CIMD_STALE_OK_SECONDS) return toClient(row);
    return null;
  }

  const row = await env.DB.prepare(`SELECT * FROM oauth_clients WHERE client_id = ? AND kind = 'DCR'`)
    .bind(clientId)
    .first<ClientDbRow>();
  return row ? toClient(row) : null;
}

// ---------- 認可リクエスト ----------
export interface AuthzRequest {
  client: ClientRow;
  redirectUri: string;
  scopes: Scope[];
  state: string | null;
  codeChallenge: string;
  resource: string;
}

export type AuthzParse =
  | { ok: true; req: AuthzRequest }
  /** redirectTo があるときだけ、戻り先へエラーを返せる（client_id・redirect_uriが信頼できる場合のみ） */
  | { ok: false; error: string; description: string; redirectTo?: string };

export function errorRedirectUrl(redirectUri: string, issuer: string, error: string, description: string, state: string | null): string {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  u.searchParams.set('iss', issuer);
  return u.toString();
}

/** 認可リクエスト（/oauth/authorize のクエリ）を検証する。承認画面とその決定APIも毎回これを通す */
export async function parseAuthorizationRequest(
  env: Env,
  params: URLSearchParams,
  issuer: string,
  ip: string,
): Promise<AuthzParse> {
  const clientId = params.get('client_id') ?? '';
  if (!clientId) return { ok: false, error: 'invalid_request', description: 'client_id is required' };
  const client = await getClient(env, clientId, ip);
  if (!client) return { ok: false, error: 'invalid_client', description: 'unknown or invalid client_id' };

  const redirectUri = params.get('redirect_uri') ?? '';
  if (!redirectUri) return { ok: false, error: 'invalid_request', description: 'redirect_uri is required' };
  if (!redirectUriMatches(client.redirect_uris, redirectUri)) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri does not match a registered value' };
  }

  // ここから先は戻り先が信頼できるので、エラーは戻り先へ返す
  const rawState = params.get('state');
  const state = rawState && rawState.length <= 512 ? rawState : null;
  const bad = (error: string, description: string): AuthzParse => ({
    ok: false, error, description, redirectTo: errorRedirectUrl(redirectUri, issuer, error, description, state),
  });

  if (rawState && rawState.length > 512) return bad('invalid_request', 'state is too long');
  if (params.get('response_type') !== 'code') return bad('unsupported_response_type', 'response_type must be "code"');

  const challenge = params.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return bad('invalid_request', 'code_challenge is required (S256, 43 characters)');
  if (params.get('code_challenge_method') !== 'S256') return bad('invalid_request', 'code_challenge_method must be "S256"');

  const parsed = parseScopes(params.get('scope'));
  if ('error' in parsed) return bad('invalid_scope', parsed.error);

  const resource = resourceOf(issuer);
  for (const r of params.getAll('resource')) {
    if (!sameResource(r, resource)) return bad('invalid_target', `resource must be ${resource}`);
  }

  return { ok: true, req: { client, redirectUri, scopes: parsed.scopes, state, codeChallenge: challenge, resource } };
}

// ---------- 許可・トークン ----------
export const CODE_TTL_SECONDS = 120;
export const REFRESH_TTL_SECONDS = 30 * 86400;
export const MAX_GRANTS_PER_USER = 20;

export function accessTtl(env: Env): number {
  const n = Number(env.OAUTH_ACCESS_TOKEN_TTL_SECONDS || '3600');
  return Number.isFinite(n) && n >= 60 ? Math.floor(n) : 3600;
}

/** 許可を取り消し、そのトークン・コードを全削除する */
export async function revokeGrant(env: Env, grantId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(now, grantId),
    env.DB.prepare(`DELETE FROM oauth_tokens WHERE grant_id = ?`).bind(grantId),
    env.DB.prepare(`DELETE FROM oauth_codes WHERE grant_id = ?`).bind(grantId),
  ]);
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** アクセストークンとリフレッシュトークンを発行する（D1にはハッシュだけを保存） */
export async function issueTokens(env: Env, grantId: string, scope: string, extraStmts: D1PreparedStatement[] = []): Promise<IssuedTokens> {
  const now = Math.floor(Date.now() / 1000);
  const access = newAccessToken();
  const refresh = newRefreshToken();
  const ttl = accessTtl(env);
  await env.DB.batch([
    ...extraStmts,
    env.DB.prepare(
      `INSERT INTO oauth_tokens (token_hash, grant_id, kind, scope, expires_at, created_at) VALUES (?, ?, 'ACCESS', ?, ?, ?)`,
    ).bind(await hashToken(access), grantId, scope, now + ttl, now),
    env.DB.prepare(
      `INSERT INTO oauth_tokens (token_hash, grant_id, kind, scope, expires_at, created_at) VALUES (?, ?, 'REFRESH', ?, ?, ?)`,
    ).bind(await hashToken(refresh), grantId, scope, now + REFRESH_TTL_SECONDS, now),
  ]);
  return { access_token: access, refresh_token: refresh, expires_in: ttl };
}

export interface AccessAuth {
  userId: string;
  grantId: string;
  scopes: Set<Scope>;
}

/**
 * /mcp のベアラートークンを検証する。宛先(resource)が自分である許可のトークンだけを受け付け、
 * 持ち主が ACTIVE でなければ（凍結・削除）その場で無効にする。
 */
export async function verifyAccessToken(
  env: Env,
  token: string,
  resource: string,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<AccessAuth | null> {
  if (!token.startsWith('dta_') || token.length > 200) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT t.scope AS scope, g.id AS grant_id, g.user_id AS user_id, g.last_used_at AS last_used_at
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       JOIN users u ON u.id = g.user_id
      WHERE t.token_hash = ? AND t.kind = 'ACCESS' AND t.expires_at > ?
        AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND g.resource = ? AND u.status = 'ACTIVE'`,
  )
    .bind(await hashToken(token), now, resource)
    .first<{ scope: string; grant_id: string; user_id: string; last_used_at: number | null }>();
  if (!row) return null;

  // 書き込みを減らすため、5分以上空いたときだけ最終利用時刻を更新する
  if (!row.last_used_at || row.last_used_at < now - 300) {
    const p = env.DB.prepare(`UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`).bind(now, row.grant_id).run().catch(() => {});
    if (ctx) ctx.waitUntil(p);
  }
  const scopes = new Set<Scope>(row.scope.split(' ').filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)));
  return { userId: row.user_id, grantId: row.grant_id, scopes };
}

/** Cronから呼ぶ掃除（仕様書4.17） */
export async function cleanupOauth(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM oauth_grants WHERE activated_at IS NULL AND created_at < ?`).bind(now - 86400),
    env.DB.prepare(`DELETE FROM oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?`).bind(now - 30 * 86400),
    env.DB.prepare(
      `DELETE FROM oauth_clients
        WHERE (CASE WHEN kind = 'CIMD' THEN fetched_at ELSE created_at END) < ?
          AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)`,
    ).bind(now - 30 * 86400),
  ]);
}
