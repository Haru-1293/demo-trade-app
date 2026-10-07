/**
 * ライブ株価WebSocket（/api/live-prices）で、クライアントから上流(Yahoo)へ中継するメッセージの検証。
 * 認証済みの利用者でも、任意のフレームを上流へ送れないようにし、購読数に上限を設ける（上流・Workerの資源の保護）。
 * 受け付けるのは {"subscribe":[...]} / {"unsubscribe":[...]} のみ。
 */
const SYMBOL_PATTERN = /^[A-Za-z0-9.\-=^]{1,20}$/;
export const MAX_WS_MESSAGE_CHARS = 8192;
export const MAX_SYMBOLS_PER_MESSAGE = 50;
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 150;

/**
 * @param subscribed この接続で現在購読中のシンボル（この関数が更新する）
 * @returns 上流へ送る文字列。送るものが無ければ null
 */
export function sanitizeClientMessage(data: unknown, subscribed: Set<string>): string | null {
  if (typeof data !== 'string' || data.length > MAX_WS_MESSAGE_CHARS) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  const out: { subscribe?: string[]; unsubscribe?: string[] } = {};

  const clean = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === 'string' && SYMBOL_PATTERN.test(s)).slice(0, MAX_SYMBOLS_PER_MESSAGE)
      : [];

  const unsub = clean(m.unsubscribe);
  if (unsub.length) {
    unsub.forEach((s) => subscribed.delete(s));
    out.unsubscribe = unsub;
  }
  const sub: string[] = [];
  for (const s of clean(m.subscribe)) {
    if (subscribed.has(s)) continue;
    if (subscribed.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) break;
    subscribed.add(s);
    sub.push(s);
  }
  if (sub.length) out.subscribe = sub;

  return out.subscribe || out.unsubscribe ? JSON.stringify(out) : null;
}
