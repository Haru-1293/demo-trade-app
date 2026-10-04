import type { Env } from '../types';

/**
 * 仕様書 4.6: 外部データソース = Yahoo Finance Chart API
 *   プライマリ: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
 *   代替:       https://query2.finance.yahoo.com/v8/finance/chart/{symbol}
 * 60秒キャッシュ（symbol単位）。OHLC遡及判定用データはキャッシュ対象外。
 */

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'] as const;

export interface ChartQuote {
  price: number;
  fetchedAt: number; // UNIX秒
}

export interface OhlcPoint {
  timestamp: number;
  high: number;
  low: number;
}

async function fetchChartRaw(
  symbol: string,
  params: Record<string, string>,
): Promise<any | null> {
  const qs = new URLSearchParams(params).toString();
  for (const host of HOSTS) {
    try {
      const res = await fetch(`https://${host}/v8/finance/chart/${symbol}?${qs}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as any;
      if (json?.chart?.error) continue;
      return json;
    } catch {
      continue; // 代替ホストへフォールバック
    }
  }
  return null; // プライマリ・代替とも失敗 → 呼び出し元でDATA_UNAVAILABLEとして扱う
}

/** 成行注文・両替用の現在値取得（60秒キャッシュ利用） */
export async function getCurrentPrice(
  env: Env,
  symbol: string,
): Promise<ChartQuote | null> {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/price/${symbol}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return (await cached.json()) as ChartQuote;
  }

  const json = await fetchChartRaw(symbol, { interval: '1m', range: '1d' });
  if (!json) return null;

  const meta = json.chart.result?.[0]?.meta;
  const price: number | undefined = meta?.regularMarketPrice;
  if (typeof price !== 'number') return null;

  const quote: ChartQuote = { price, fetchedAt: Math.floor(Date.now() / 1000) };
  const ttl = Number(env.MARKET_DATA_CACHE_SECONDS || '60');
  const response = new Response(JSON.stringify(quote), {
    headers: { 'Cache-Control': `max-age=${ttl}` },
  });
  await cache.put(cacheKey, response);
  return quote;
}

/**
 * 表示専用の現在値（KVに30分キャッシュ）。成行・指値の約定判定・両替には使わない（そちらは getCurrentPrice の60秒キャッシュ）。
 * 用途: WSSの初回tickが届くまでの暫定表示（ホーム・注文・検索）、マイページ/日次スナップショットの評価額。
 * キャッシュが無い銘柄だけ Yahoo Finance Chart API へ取りに行き、結果をKVへ書く。
 * KVの書き込みに失敗しても（Freeプランの日次上限など）、取得できた値はそのまま返す。
 */
export interface DisplayPrice {
  price: number;
  asOf: number; // この価格を取得した時刻（UNIX秒）
}

export async function getDisplayPrices(
  env: Env,
  symbols: string[],
): Promise<Map<string, DisplayPrice>> {
  const unique = [...new Set(symbols)].filter(Boolean);
  const out = new Map<string, DisplayPrice>();
  if (!unique.length) return out;

  const ttl = Math.max(60, Number(env.DISPLAY_PRICE_CACHE_SECONDS || '1800')); // KVのexpirationTtlは最小60秒
  const keyOf = (s: string) => `dp:${s}`;

  // KVはまとめ読み（1回のgetで最大100キー）
  const misses: string[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    let found: Map<string, DisplayPrice | null> | null = null;
    try {
      found = (await env.RATE_LIMIT_KV.get<DisplayPrice>(chunk.map(keyOf), 'json')) as Map<string, DisplayPrice | null>;
    } catch {
      found = null;
    }
    for (const s of chunk) {
      const v = found?.get(keyOf(s));
      if (v && typeof v.price === 'number') out.set(s, v);
      else misses.push(s);
    }
  }

  // キャッシュに無い分だけ外部取得（同時実行数を絞る）
  const CONCURRENCY = 8;
  for (let i = 0; i < misses.length; i += CONCURRENCY) {
    const chunk = misses.slice(i, i + CONCURRENCY);
    const quotes = await Promise.all(chunk.map((s) => getCurrentPrice(env, s).catch(() => null)));
    await Promise.all(
      chunk.map(async (s, idx) => {
        const q = quotes[idx];
        if (!q) return;
        const dp: DisplayPrice = { price: q.price, asOf: q.fetchedAt };
        out.set(s, dp);
        try {
          await env.RATE_LIMIT_KV.put(keyOf(s), JSON.stringify(dp), { expirationTtl: ttl });
        } catch {
          /* 書き込み上限などでも表示は続ける */
        }
      }),
    );
  }
  return out;
}

/** USD/JPY 為替レート取得（同一エンドポイント、symbol固定 "JPY=X"、60秒キャッシュ） */
export async function getUsdJpyRate(env: Env): Promise<ChartQuote | null> {
  return getCurrentPrice(env, 'JPY=X');
}

/**
 * 指値の遡及判定用OHLC取得（4.4）。キャッシュ対象外、毎回取得。
 * 期間の長さに応じてintervalを切り替える。
 */
export async function getOhlcHistory(
  symbol: string,
  fromUnix: number,
  toUnix: number,
): Promise<OhlcPoint[] | null> {
  const spanDays = (toUnix - fromUnix) / 86400;
  const interval = spanDays <= 5 ? '5m' : '1d';
  const range = spanDays <= 1 ? '1d' : spanDays <= 5 ? '5d' : '1mo';

  const json = await fetchChartRaw(symbol, { interval, range });
  if (!json) return null;

  const result = json.chart.result?.[0];
  const timestamps: number[] = result?.timestamp ?? [];
  const highs: (number | null)[] = result?.indicators?.quote?.[0]?.high ?? [];
  const lows: (number | null)[] = result?.indicators?.quote?.[0]?.low ?? [];

  const points: OhlcPoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const h = highs[i];
    const l = lows[i];
    if (ts != null && h != null && l != null && ts >= fromUnix && ts <= toUnix) {
      points.push({ timestamp: ts, high: h, low: l });
    }
  }
  return points;
}
