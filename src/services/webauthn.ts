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
    rpID: env.WEBAUTHN_RP_ID,
    userID: new TextEncoder().encode(userId) as Uint8Array<ArrayBuffer>,
    userName: email,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });

  await env.RATE_LIMIT_KV.put(challengeKey('reg', userId), options.challenge, {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });

  return options;
}

export async function verifyRegistration(
  env: Env,
  userId: string,
  response: RegistrationResponseJSON,
): Promise<{ verified: boolean; credentialId?: string; publicKeyB64url?: string; counter?: number; transports?: string[] }> {
  const expectedChallenge = await env.RATE_LIMIT_KV.get(challengeKey('reg', userId));
  if (!expectedChallenge) return { verified: false };

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: env.WEBAUTHN_ORIGIN,
    expectedRPID: env.WEBAUTHN_RP_ID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false };
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
    rpID: env.WEBAUTHN_RP_ID,
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
): Promise<{ verified: boolean; newCounter?: number }> {
  const expectedChallenge = await env.RATE_LIMIT_KV.get(challengeKey('auth', userId));
  if (!expectedChallenge) return { verified: false };

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: env.WEBAUTHN_ORIGIN,
    expectedRPID: env.WEBAUTHN_RP_ID,
    credential: {
      id: storedCredential.credential_id,
      publicKey: base64urlToUint8Array(storedCredential.public_key) as Uint8Array<ArrayBuffer>,
      counter: storedCredential.counter,
      transports: storedCredential.transports ? JSON.parse(storedCredential.transports) : undefined,
    },
  });

  if (!verification.verified) return { verified: false };
  return { verified: true, newCounter: verification.authenticationInfo.newCounter };
}
