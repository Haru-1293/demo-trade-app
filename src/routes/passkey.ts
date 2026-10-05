import { Hono } from 'hono';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env, WebauthnCredentialRow } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { issueSession } from '../services/session';
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

/**
 * 標準ユーザーのパスキー認証（仕様書 4.16）
 * 管理画面のパスキー（scope='ADMIN'、routes/adminAuth.ts）とは別物で、ここで扱うのは scope='USER' のみ。
 */
const app = new Hono<{ Bindings: Env }>();

const MAX_PASSKEYS_PER_USER = 10;
const MAX_LABEL_LENGTH = 60;

function base64urlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
}

/** POST /api/passkey/register-options — ログイン中ユーザーが、自分のパスキーを追加するためのオプションを取得 */
app.post('/register-options', requireCsrf, requireAuth, async (c) => {
  const configError = webauthnConfigError(c.env);
  if (configError) return c.json({ error: configError }, 503);
  const auth = c.get('auth');

  const user = await c.env.DB.prepare(`SELECT id, username FROM users WHERE id = ?`)
    .bind(auth.userId)
    .first<{ id: string; username: string }>();
  if (!user) return c.json({ error: 'not found' }, 404);

  const { results: existing } = await c.env.DB.prepare(
    `SELECT * FROM webauthn_credentials WHERE user_id = ? AND scope = 'USER'`,
  )
    .bind(user.id)
    .all<WebauthnCredentialRow>();
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    return c.json({ error: `登録できるパスキーは${MAX_PASSKEYS_PER_USER}件までです` }, 400);
  }

  try {
    return c.json(await createUserRegistrationOptions(c.env, user, existing));
  } catch (e) {
    return c.json({ error: 'failed to create options', detail: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** POST /api/passkey/register-verify — 登録の検証と保存。body: { credential, label? } */
app.post('/register-verify', requireCsrf, requireAuth, async (c) => {
  const configError = webauthnConfigError(c.env);
  if (configError) return c.json({ error: configError }, 503);
  const auth = c.get('auth');

  const body = await c.req
    .json<{ credential: RegistrationResponseJSON; label?: string }>()
    .catch(() => null);
  if (!body || !body.credential) return c.json({ error: 'credential required' }, 400);

  const result = await verifyUserRegistration(c.env, auth.userId, body.credential);
  if (!result.verified) {
    return c.json({ error: 'verification failed', detail: result.error }, 400);
  }

  const label = (body.label ?? '').toString().trim().slice(0, MAX_LABEL_LENGTH) || null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, label, created_at, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USER')`,
    )
      .bind(
        crypto.randomUUID(),
        auth.userId,
        result.credentialId,
        result.publicKeyB64url,
        result.counter ?? 0,
        result.transports ? JSON.stringify(result.transports) : null,
        label,
        Math.floor(Date.now() / 1000),
      )
      .run();
  } catch {
    // credential_id のUNIQUE制約違反（すでに登録済みの認証器）
    return c.json({ error: 'このパスキーはすでに登録されています' }, 409);
  }
  return c.json({ ok: true }, 201);
});

/** GET /api/passkey/credentials — 自分のパスキー一覧（設定画面用） */
app.get('/credentials', requireAuth, async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT id, label, created_at, last_used_at FROM webauthn_credentials
     WHERE user_id = ? AND scope = 'USER' ORDER BY created_at DESC`,
  )
    .bind(auth.userId)
    .all();
  return c.json({ credentials: results });
});

/** DELETE /api/passkey/credentials/:id — 自分のパスキーを削除（パスワードでのログインは常に可能なので、締め出しにはならない） */
app.delete('/credentials/:id', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const res = await c.env.DB.prepare(
    `DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ? AND scope = 'USER'`,
  )
    .bind(c.req.param('id'), auth.userId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

/**
 * POST /api/passkey/login-options — ユーザー名なしのパスキーログイン開始（要ログインではない）
 * allowCredentials を指定しないため、端末に保存されたこのサイトのパスキーから選んで認証できる。
 */
app.post('/login-options', async (c) => {
  const configError = webauthnConfigError(c.env);
  if (configError) return c.json({ error: configError }, 503);
  try {
    return c.json(await createUsernamelessAuthOptions(c.env));
  } catch (e) {
    if (e instanceof TooManyChallengesError) return c.json({ error: 'しばらくしてからもう一度お試しください' }, 429);
    return c.json({ error: 'failed to create options', detail: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** POST /api/passkey/login-verify — 署名を検証してセッションを発行。body: { credential } */
app.post('/login-verify', async (c) => {
  const configError = webauthnConfigError(c.env);
  if (configError) return c.json({ error: configError }, 503);

  const fail = (detail: string) => c.json({ error: 'パスキーでログインできませんでした', detail }, 401);

  const body = await c.req.json<{ credential: AuthenticationResponseJSON }>().catch(() => null);
  const credential = body?.credential;
  if (!credential || typeof credential.id !== 'string' || !credential.response) return fail('invalid body');

  // 1. チャレンジを取り出して消費する（使い回し・期限切れ・自分が発行していないチャレンジは弾く）
  const challenge = extractClientDataChallenge(credential);
  if (!challenge || !(await consumeAuthChallenge(c.env, challenge))) return fail('challenge expired or not found');

  // 2. 標準ユーザー用(scope='USER')のパスキーだけを対象に、credential_id から持ち主を引く
  const stored = await c.env.DB.prepare(
    `SELECT * FROM webauthn_credentials WHERE credential_id = ? AND scope = 'USER'`,
  )
    .bind(credential.id)
    .first<WebauthnCredentialRow>();
  if (!stored) return fail('unknown credential');

  // 3. 端末が返すユーザーハンドル（登録時のユーザーID）が、持ち主と一致することを確認
  const userHandle = credential.response.userHandle;
  if (userHandle && base64urlToString(userHandle) !== stored.user_id) return fail('user handle mismatch');

  const user = await c.env.DB.prepare(`SELECT id, status FROM users WHERE id = ?`)
    .bind(stored.user_id)
    .first<{ id: string; status: string }>();
  if (!user || user.status !== 'ACTIVE') return fail('account is not active');

  // 4. 署名検証
  const result = await verifyUserAuthentication(c.env, challenge, credential, stored);
  if (!result.verified) return fail(result.error ?? 'verification failed');

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?`)
    .bind(result.newCounter ?? stored.counter, now, stored.id)
    .run();

  const csrfToken = await issueSession(c, user.id, now);
  return c.json({ ok: true, csrf_token: csrfToken });
});

export default app;
