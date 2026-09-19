import type { Env } from '../types';

/** 仕様書4.1: ログイン・登録どちらもTurnstile検証を必須とする。管理画面ログインでも再利用する。 */
export async function verifyTurnstile(env: Env, token: string, remoteIp?: string): Promise<boolean> {
  if (!token) return false;
  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const json = await res.json<{ success: boolean }>();
    return json.success === true;
  } catch {
    return false; // 検証サービス自体に問題がある場合は安全側に倒して拒否
  }
}
