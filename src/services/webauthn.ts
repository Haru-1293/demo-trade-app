import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { Env, WebauthnCredentialRow } from '../types';

/**
 * CBORデコード・COSE公開鍵の解釈・署名検証(ES256/RS256等)は自前で書くと
 * 間違えやすく認証バイパスに直結するリスクがあるため、@simplewebauthn/serverに委譲する。
 * このファイルはチャレンジのKV保存や本アプリのDB形式との橋渡しのみを担当する。
 *
 * 注意: @simplewebauthn/serverはバージョンによって引数名・返り値の形が変わることがある
 * （例: v13で `credential` 引数が `response` にリネーム、`userID`がUint8Array化等）。
 * ここではv13系のAPIを前提に実装しているが、実際に `npm install` した際のバージョンの
 * 型定義と食い違いがあれば、そちらに合わせて調整すること（デプロイ前に必ず型チェックを通すこと）。
 */

const CHALLENGE_TTL_SECONDS = 300; // 5分

function challengeKey(kind: 'reg' | 'auth', userId: string): string {
  return `webauthn_challenge:${kind}:${userId}`;
}

/**
 * WebAuthnのオリジン比較は完全一致（ブラウザが送るclientDataJSONのoriginは末尾スラッシュ無し）。
 * 環境変数の設定ミス（末尾の"/"付きURLをそのままコピペした場合など）で
 * 検証が失敗しないよう、末尾のスラッシュを除去して正規化する。
 */
function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/**
 * RP IDはスキーム(https://)やポート・パスを含まないホスト名のみ。
 * 誤って"https://example.com/"のように貼り付けられても、ホスト名部分だけを取り出して正規化する。
 */
function normalizeRpId(rpId: string): string {
  return rpId.trim().replace(/^https?:\/\//, '').replace(/[\/:].*$/, '');
}

function base64urlToUint8Array(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createRegistrationOptions(
  env: Env,
  userId: string,
  email: string,
  existingCredentials: WebauthnCredentialRow[],
) {
  const options = await generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: normalizeRpId(env.WEBAUTHN_RP_ID),
    userID: new TextEncoder().encode(userId) as Uint8Array<ArrayBuffer>,
    userName: email,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });
  // generateRegistrationOptions自体は expectedOrigin との突合せをしないため例外は起きにくいが、
  // rpID が空文字列等だと内部でエラーになりうるため、呼び出し元(ルートハンドラ)でも
  // try/catchしてJSONエラーとして返すこと（500を素通しさせない）。

  await env.RATE_LIMIT_KV.put(challengeKey('reg', userId), options.challenge, {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });

  return options;
}

export async function verifyRegistration(
  env: Env,
  userId: string,
  response: RegistrationResponseJSON,
): Promise<{ verified: boolean; credentialId?: string; publicKeyB64url?: string; counter?: number; transports?: string[]; error?: string }> {
  const expectedChallenge = await env.RATE_LIMIT_KV.get(challengeKey('reg', userId));
  if (!expectedChallenge) return { verified: false, error: 'challenge expired or not found' };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: normalizeOrigin(env.WEBAUTHN_ORIGIN),
      expectedRPID: normalizeRpId(env.WEBAUTHN_RP_ID),
    });
  } catch (e) {
    // WEBAUTHN_RP_ID/WEBAUTHN_ORIGIN が実際のデプロイ先ドメインと一致していない場合、
    // @simplewebauthn/server はエラーをthrowする。ここで捕捉せず素通しすると
    // ルートハンドラ側で未捕捉例外となりHTTP 500になってしまうため、必ず捕捉する。
    return { verified: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false, error: 'verification returned not verified' };
  }

  const { credential } = verification.registrationInfo;
  return {
    verified: true,
    credentialId: credential.id,
    publicKeyB64url: uint8ArrayToBase64url(credential.publicKey),
    counter: credential.counter,
    transports: response.response.transports,
  };
}

export async function createAuthenticationOptions(
  env: Env,
  userId: string,
  credentials: WebauthnCredentialRow[],
) {
  const options = await generateAuthenticationOptions({
    rpID: normalizeRpId(env.WEBAUTHN_RP_ID),
    allowCredentials: credentials.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });

  await env.RATE_LIMIT_KV.put(challengeKey('auth', userId), options.challenge, {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });

  return options;
}

export async function verifyAuthentication(
  env: Env,
  userId: string,
  response: AuthenticationResponseJSON,
  storedCredential: WebauthnCredentialRow,
): Promise<{ verified: boolean; newCounter?: number; error?: string }> {
  const expectedChallenge = await env.RATE_LIMIT_KV.get(challengeKey('auth', userId));
  if (!expectedChallenge) return { verified: false, error: 'challenge expired or not found' };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: normalizeOrigin(env.WEBAUTHN_ORIGIN),
      expectedRPID: normalizeRpId(env.WEBAUTHN_RP_ID),
      credential: {
        id: storedCredential.credential_id,
        publicKey: base64urlToUint8Array(storedCredential.public_key) as Uint8Array<ArrayBuffer>,
        counter: storedCredential.counter,
        transports: storedCredential.transports ? JSON.parse(storedCredential.transports) : undefined,
      },
    });
  } catch (e) {
    return { verified: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!verification.verified) return { verified: false, error: 'verification returned not verified' };
  return { verified: true, newCounter: verification.authenticationInfo.newCounter };
}

// =====================================================================
// 標準ユーザー向けパスキー（仕様書4.16）
// チャレンジはKVではなくD1（webauthn_challenges）に保存する。KVはFreeプランで書き込みが1日1,000回までのため、
// 認証前に誰でも叩ける login-options で枯渇させられるのを避ける。
// =====================================================================

const USER_RP_NAME = 'デモトレード';
const MAX_OUTSTANDING_AUTH_CHALLENGES = 1000; // 未使用のログイン用チャレンジの上限（認証前のエンドポイントの連打対策）

export class TooManyChallengesError extends Error {}

/** WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN が未設定・ビルド時注入前のプレースホルダーのままなら、利用者向けのエラー文を返す */
export function webauthnConfigError(env: Env): string | null {
  const bad = (v: unknown) => typeof v !== 'string' || !v.trim() || v.trim().startsWith('__');
  if (bad(env.WEBAUTHN_RP_ID) || bad(env.WEBAUTHN_ORIGIN)) {
    return 'パスキーの設定（WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN）が完了していません';
  }
  return null;
}

/** チャレンジを1回だけ取り出す（取り出したら削除。期限切れ・使用済みは null）。DELETE ... RETURNING で原子的に行う */
async function consumeChallenge(
  env: Env,
  kind: 'USER_REG' | 'USER_AUTH',
  by: { challenge: string } | { userId: string },
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const [column, value] = 'challenge' in by ? ['challenge', by.challenge] : ['user_id', by.userId];
  const { results } = await env.DB.prepare(
    `DELETE FROM webauthn_challenges WHERE ${column} = ? AND kind = ? AND expires_at >= ? RETURNING challenge`,
  )
    .bind(value, kind, now)
    .all<{ challenge: string }>();
  return results[0]?.challenge ?? null;
}

/** 登録（ログイン済みユーザーが自分のパスキーを追加）。ユーザー名なしログインのため discoverable credential を必須にする */
export async function createUserRegistrationOptions(
  env: Env,
  user: { id: string; username: string },
  existingCredentials: WebauthnCredentialRow[],
) {
  const options = await generateRegistrationOptions({
    rpName: USER_RP_NAME,
    rpID: normalizeRpId(env.WEBAUTHN_RP_ID),
    userID: new TextEncoder().encode(user.id) as Uint8Array<ArrayBuffer>,
    userName: user.username,
    userDisplayName: user.username,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM webauthn_challenges WHERE (user_id = ? AND kind = 'USER_REG') OR expires_at < ?`).bind(user.id, now),
    env.DB.prepare(
      `INSERT INTO webauthn_challenges (challenge, kind, user_id, expires_at) VALUES (?, 'USER_REG', ?, ?)`,
    ).bind(options.challenge, user.id, now + CHALLENGE_TTL_SECONDS),
  ]);
  return options;
}

export async function verifyUserRegistration(
  env: Env,
  userId: string,
  response: RegistrationResponseJSON,
): Promise<{ verified: boolean; credentialId?: string; publicKeyB64url?: string; counter?: number; transports?: string[]; error?: string }> {
  const expectedChallenge = await consumeChallenge(env, 'USER_REG', { userId });
  if (!expectedChallenge) return { verified: false, error: 'challenge expired or not found' };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: normalizeOrigin(env.WEBAUTHN_ORIGIN),
      expectedRPID: normalizeRpId(env.WEBAUTHN_RP_ID),
      requireUserVerification: true,
    });
  } catch (e) {
    return { verified: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false, error: 'verification returned not verified' };
  }
  const { credential } = verification.registrationInfo;
  return {
    verified: true,
    credentialId: credential.id,
    publicKeyB64url: uint8ArrayToBase64url(credential.publicKey),
    counter: credential.counter,
    transports: response.response.transports,
  };
}

/** ユーザー名なし（discoverable credential）ログイン用のオプション。allowCredentials は指定しない */
export async function createUsernamelessAuthOptions(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ?`).bind(now).run();
  const outstanding = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM webauthn_challenges WHERE kind = 'USER_AUTH'`,
  ).first<{ n: number }>();
  if ((outstanding?.n ?? 0) >= MAX_OUTSTANDING_AUTH_CHALLENGES) throw new TooManyChallengesError();

  const options = await generateAuthenticationOptions({
    rpID: normalizeRpId(env.WEBAUTHN_RP_ID),
    userVerification: 'required',
  });
  await env.DB.prepare(
    `INSERT INTO webauthn_challenges (challenge, kind, user_id, expires_at) VALUES (?, 'USER_AUTH', NULL, ?)`,
  )
    .bind(options.challenge, now + CHALLENGE_TTL_SECONDS)
    .run();
  return options;
}

/** ブラウザが返す clientDataJSON から、署名対象のチャレンジ文字列を取り出す（ユーザー未確定のため、これでチャレンジを引く） */
export function extractClientDataChallenge(response: AuthenticationResponseJSON): string | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(base64urlToUint8Array(response.response.clientDataJSON)));
    return typeof json.challenge === 'string' ? json.challenge : null;
  } catch {
    return null;
  }
}

/** ログイン用チャレンジを1回だけ消費する。成功＝このチャレンジは自分が発行した未使用・未期限のもの */
export async function consumeAuthChallenge(env: Env, challenge: string): Promise<boolean> {
  return (await consumeChallenge(env, 'USER_AUTH', { challenge })) !== null;
}

export async function verifyUserAuthentication(
  env: Env,
  expectedChallenge: string,
  response: AuthenticationResponseJSON,
  storedCredential: WebauthnCredentialRow,
): Promise<{ verified: boolean; newCounter?: number; error?: string }> {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: normalizeOrigin(env.WEBAUTHN_ORIGIN),
      expectedRPID: normalizeRpId(env.WEBAUTHN_RP_ID),
      requireUserVerification: true,
      credential: {
        id: storedCredential.credential_id,
        publicKey: base64urlToUint8Array(storedCredential.public_key) as Uint8Array<ArrayBuffer>,
        counter: storedCredential.counter,
        transports: storedCredential.transports ? JSON.parse(storedCredential.transports) : undefined,
      },
    });
  } catch (e) {
    return { verified: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!verification.verified) return { verified: false, error: 'verification returned not verified' };
  return { verified: true, newCounter: verification.authenticationInfo.newCounter };
}
