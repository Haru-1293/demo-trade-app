import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env } from '../types';
import { generateSessionToken, hashSessionToken } from './crypto';
import { generateCsrfToken } from '../middleware/csrf';

/**
 * セッションとCSRFトークンの発行・複数アカウントの管理（仕様書4.1.1）。
 *
 * - `session` Cookie（HttpOnly）: いま使っているアカウントのセッショントークン。サーバーの認証（requireAuth）はこれだけを見る。
 * - `sessions` Cookie（HttpOnly）: この端末でログイン中の全アカウントのセッショントークン（カンマ区切り、最大 MAX_ACCOUNTS）。
 *   切替の候補を保持するだけで、これ自体では認証されない。切替時はDBでトークンを検証し、持ち主を確かめてから `session` に載せる。
 * - `csrf_token` Cookie: アカウントによらず共通（ダブルサブミット方式。セッションとは結び付けていない）。
 */
export const MAX_ACCOUNTS = 5;

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function sessionCookieName(c: Context<{ Bindings: Env }>): string {
  return c.env.SESSION_COOKIE_NAME || 'session';
}
function listCookieName(c: Context<{ Bindings: Env }>): string {
  return `${sessionCookieName(c)}s`;
}

function readCookie(c: Context<{ Bindings: Env }>, name: string): string | null {
  const header = c.req.header('Cookie') ?? '';
  const m = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export interface LoggedInAccount {
  token: string;
  userId: string;
  username: string;
}

/** Cookieに載っているトークン（アクティブ＋一覧）を、重複なし・形式チェック済みで返す。アクティブが先頭 */
export function candidateTokens(c: Context<{ Bindings: Env }>): string[] {
  const out: string[] = [];
  const push = (t: string | null | undefined) => {
    if (t && TOKEN_RE.test(t) && !out.includes(t)) out.push(t);
  };
  for (const t of (readCookie(c, listCookieName(c)) ?? '').split(',')) push(t); // 並び順は一覧Cookieのまま（切り替えても入れ替わらない）
  push(readCookie(c, sessionCookieName(c))); // この機能より前のログイン（一覧Cookieなし）も拾う
  return out.slice(0, MAX_ACCOUNTS + 1);
}

/** 有効な（期限内で、ユーザーがACTIVE）セッションだけを、端末内の並び順で返す。同じユーザーは先頭の1つだけ */
export async function loggedInAccounts(c: Context<{ Bindings: Env }>): Promise<LoggedInAccount[]> {
  const tokens = candidateTokens(c);
  const now = Math.floor(Date.now() / 1000);
  const out: LoggedInAccount[] = [];
  for (const token of tokens) {
    const row = await c.env.DB.prepare(
      `SELECT u.id AS user_id, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = ? AND s.expires_at >= ? AND u.status = 'ACTIVE'`,
    )
      .bind(await hashSessionToken(token), now)
      .first<{ user_id: string; username: string }>();
    if (row && !out.some((a) => a.userId === row.user_id)) out.push({ token, userId: row.user_id, username: row.username });
  }
  return out;
}

function cookieAttrs(maxAge: number): string {
  return `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** 一覧Cookieとアクティブ（先頭）の `session` Cookieを書く。空ならすべて消す（csrf_tokenも） */
export function writeAccounts(c: Context<{ Bindings: Env }>, accounts: LoggedInAccount[], activeUserId?: string): void {
  const ttlDays = Number(c.env.SESSION_TTL_DAYS || '30');
  const name = sessionCookieName(c);
  if (!accounts.length) {
    c.header('Set-Cookie', `${name}=; ${cookieAttrs(0)}`, { append: true });
    c.header('Set-Cookie', `${listCookieName(c)}=; ${cookieAttrs(0)}`, { append: true });
    c.header('Set-Cookie', `csrf_token=; Secure; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
    return;
  }
  const active = accounts.find((a) => a.userId === activeUserId) ?? accounts[0]!;
  c.header('Set-Cookie', `${name}=${active.token}; ${cookieAttrs(ttlDays * 86400)}`, { append: true });
  c.header('Set-Cookie', `${listCookieName(c)}=${accounts.map((a) => a.token).join(',')}; ${cookieAttrs(ttlDays * 86400)}`, { append: true });
}

/**
 * セッションとCSRFトークンを発行してCookieに載せる（login/register/パスキーで共用）。
 * すでに別のアカウントでログイン中なら、そのアカウントはログインしたまま、新しいアカウントを追加してアクティブにする。
 * 同じアカウントで入り直したときは、古いセッションを破棄して置き換える。上限（MAX_ACCOUNTS）を超えるなら 409。
 * CSRFトークンはJS側で読み取ってヘッダーに載せる必要があるためHttpOnlyにしない（ダブルサブミットクッキー方式）。
 */
export async function issueSession(c: Context<{ Bindings: Env }>, userId: string, now: number): Promise<string> {
  const existing = await loggedInAccounts(c);
  const same = existing.filter((a) => a.userId === userId);
  const others = existing.filter((a) => a.userId !== userId);
  if (others.length >= MAX_ACCOUNTS) {
    throw new HTTPException(409, { res: c.json({ error: `account limit reached (max ${MAX_ACCOUNTS})` }, 409) });
  }

  const token = generateSessionToken();
  const idHash = await hashSessionToken(token);
  const ttlDays = Number(c.env.SESSION_TTL_DAYS || '30');
  const expiresAt = now + ttlDays * 86400;

  const stmts = [
    c.env.DB.prepare(`INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .bind(idHash, userId, expiresAt, now),
  ];
  for (const a of same) stmts.push(c.env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await hashSessionToken(a.token)));
  await c.env.DB.batch(stmts);

  writeAccounts(c, [...others, { token, userId, username: '' }], userId);
  const csrfToken = generateCsrfToken();
  c.header(
    'Set-Cookie',
    `csrf_token=${csrfToken}; Secure; SameSite=Lax; Path=/; Max-Age=${ttlDays * 86400}`,
    { append: true },
  );
  return csrfToken;
}
