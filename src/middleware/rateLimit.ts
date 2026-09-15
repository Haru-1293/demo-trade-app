import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';

/**
 * 仕様書4.6: 両替APIはユーザー単位で1分間に規定回数まで（デフォルト5回）。
 * Cloudflare Bot Management（ゾーンレベル）と多層で併用する。
 * MVP実装ではD1に簡易カウンタテーブルを持たせるか、Workers KVでTTL付きカウントする想定。
 * ここではインターフェースのみ定義し、実装はKV導入後に差し替える。
 */
export const fxRateLimit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.get('auth');
  const limit = Number(c.env.FX_EXCHANGE_RATE_LIMIT_PER_MIN || '5');

  // TODO: KVやDurable Objectで `fx_rate:{userId}:{minuteBucket}` のカウントを実装
  // 上限超過時: return c.json({ error: 'Too Many Requests' }, 429);
  void auth;
  void limit;

  await next();
};
