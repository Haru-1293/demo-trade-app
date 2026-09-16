import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';

/**
 * 仕様書4.6: 両替APIはユーザー単位で1分間に規定回数まで（デフォルト5回）。
 * Cloudflare Bot Management（ゾーンレベル）と多層で併用する。
 *
 * 実装方式: 固定窓カウンタ（Workers KV）。
 * キー: `fx_rate:{userId}:{unixMinuteBucket}`
 * 同一の分バケット内でのリクエスト数をカウントし、上限超過なら429を返す。
 * KVのexpirationTtlで自動失効させるため、明示的な削除処理は不要。
 *
 * 注意: KVは結果整合性（Eventually Consistent）のため、同一分内での
 * 極端に近接した同時リクエストでは厳密に上限を超えるケースがあり得る。
 * これはBot Management・requireCsrf・ログイン必須と多層防御する前提のうえでの
 * 「大まかな」レート制限として割り切る（MVPとして許容）。
 */
export const fxRateLimit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.get('auth');
  const limit = Number(c.env.FX_EXCHANGE_RATE_LIMIT_PER_MIN || '5');

  const minuteBucket = Math.floor(Date.now() / 60000);
  const key = `fx_rate:${auth.userId}:${minuteBucket}`;

  const current = await c.env.RATE_LIMIT_KV.get(key);
  const count = current ? Number(current) : 0;

  if (count >= limit) {
    return c.json({ error: 'Too Many Requests' }, 429);
  }

  // TTLは次の分バケットに移るまでの余裕を見て120秒（実質2分でクリーンアップされる）
  await c.env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 120 });

  await next();
};
