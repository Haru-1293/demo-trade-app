/**
 * 入力検証（仕様書6.）。ユーザー名・パスワードの形式を一箇所で定義する。
 * ユーザー名は管理画面など多くの画面に表示されるため、HTMLで特別な意味を持つ文字（< > " ' & 等）や
 * 制御文字・空白を許可しない。文字・数字（日本語を含む）と _ . - のみ、3〜32文字。
 */
const USERNAME_PATTERN = /^[\p{L}\p{N}_.\-]{3,32}$/u;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export function validateUsername(value: unknown): string | null {
  if (typeof value !== 'string' || !USERNAME_PATTERN.test(value)) {
    return 'ユーザー名は3〜32文字の文字・数字・「_」「.」「-」で入力してください';
  }
  return null;
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    return `パスワードは${PASSWORD_MIN}〜${PASSWORD_MAX}文字で入力してください`;
  }
  return null;
}

/** 文字列比較を、一致位置に依存しない時間で行う（トークン比較用） */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
