import type { Env } from '../types';
import { getCurrentPrice, getUsdJpyRate } from './marketData';

/**
 * 仕様書 7.4: 評価額・評価損益の計算。
 * 現在値は 4.2 と同じ Yahoo Finance Chart API（60秒キャッシュ）から取得する。
 * 取得できない銘柄は取得価格で概算し、stale=true を立てて呼び出し元へ知らせる。
 */

export interface HoldLot {
  user_id: string;
  symbol: string;
  market: 'JP' | 'US';
  quantity: number;
  buy_price: number;
  buy_rate: number;
}

export interface Valuation {
  valuationJpyC: number; // 時価評価額（円換算、銭単位）
  costJpyC: number; // 取得原価（円換算、銭単位）
  unrealizedJpyC: number; // 評価損益
  stale: boolean; // 現在値/為替が取れず概算が含まれる
}

/** 現在値を銘柄ごとに取得（同時実行数を絞る） */
export async function fetchPriceMap(env: Env, symbols: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(symbols)];
  const map = new Map<string, number>();
  const CONCURRENCY = 8;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const chunk = unique.slice(i, i + CONCURRENCY);
    const quotes = await Promise.all(chunk.map((s) => getCurrentPrice(env, s).catch(() => null)));
    chunk.forEach((s, idx) => {
      const q = quotes[idx];
      if (q) map.set(s, q.price);
    });
  }
  return map;
}

export async function fetchUsdJpy(env: Env): Promise<number | null> {
  const q = await getUsdJpyRate(env).catch(() => null);
  return q ? q.price : null;
}

export function valueHoldings(
  lots: HoldLot[],
  priceMap: Map<string, number>,
  usdJpy: number | null,
): Valuation {
  let valuation = 0;
  let cost = 0;
  let stale = false;

  for (const lot of lots) {
    const buyRate = lot.market === 'JP' ? 1 : lot.buy_rate > 0 ? lot.buy_rate : (usdJpy ?? 1);
    const costJpy = lot.buy_price * lot.quantity * buyRate;
    cost += Math.floor(costJpy * 100);

    const price = priceMap.get(lot.symbol);
    const nowRate = lot.market === 'JP' ? 1 : usdJpy ?? buyRate;
    if (price === undefined || (lot.market === 'US' && usdJpy === null)) stale = true;
    valuation += Math.floor((price ?? lot.buy_price) * lot.quantity * nowRate * 100);
  }

  return { valuationJpyC: valuation, costJpyC: cost, unrealizedJpyC: valuation - cost, stale };
}

/** 総資産(円換算) = 円残高 + USD残高×為替 + 評価額 */
export function totalAssetsJpyC(cashJpyC: number, cashUsdC: number, usdJpy: number, valuationJpyC: number): number {
  return cashJpyC + Math.floor(cashUsdC * usdJpy) + valuationJpyC;
}
