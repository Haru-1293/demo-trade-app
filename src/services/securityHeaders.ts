/**
 * HTTPレスポンスのセキュリティヘッダー（仕様書6.）。
 * Workerが返すレスポンス（/api/*）には index.ts のミドルウェアで付与し、
 * 静的ファイル（HTML/JS/CSS）には public/_headers で同じ内容を付与する（両者は同じ値に保つこと）。
 *
 * CSP: スクリプトは自サイトとTurnstileのみ（インラインスクリプト・eval不可）。インラインstyle属性も不可のため、
 *      画面のスタイルは全てCSSクラスで指定する。frame-ancestors は <meta> では効かず、HTTPヘッダーでのみ有効。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
};
