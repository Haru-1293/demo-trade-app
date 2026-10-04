import type { Env } from '../types';
import { getDisplayPrices, type DisplayPrice } from './marketData';

/**
 * 仕様書 4.11: 評価額・評価損益の計算。
 * 現在値は表示用価格（KV 30分キャッシュ、getDisplayPrices）を使う。約定判定用の60秒キャッシュとは別物。
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

/** 銘柄ごとの内訳（クライアントがWSSのライブ価格で再計算するために返す） */
export interface SymbolBreakdown {
  symbol: string;
  market: 'JP' | 'US';
  quantity: number;
  costJpyC: number; // この銘柄の取得原価（円換算、銭単位）
  valuationJpyC: number; // サーバー側の価格で計算した評価額（円換算、銭単位）
  price: number | null; // サーバーが使った現在値。取れなければ null（取得価格で概算）
  asOf: number | null; // その価格の取得時刻（UNIX秒）
}

export interface Valuation {
  valuationJpyC: number; // 時価評価額（円換算、銭単位）
  costJpyC: number; // 取得原価（円換算、銭単位）
  unrealizedJpyC: number; // 評価損益
  stale: boolean; // 現在値/為替が取れず概算が含まれる
  bySymbol: SymbolBreakdown[];
}

/** 保有銘柄の現在値とUSD/JPYを、表示用キャッシュ経由でまとめて取得する */
export async function fetchPricesAndRate(
  env: Env,
  symbols: string[],
): Promise<{ priceMap: Map<string, DisplayPrice>; usdJpy: number | null; usdJpyAsOf: number | null }> {
  const priceMap = await getDisplayPrices(env, [...symbols, 'JPY=X']);
  const rate = priceMap.get('JPY=X') ?? null;
  priceMap.delete('JPY=X');
  return { priceMap, usdJpy: rate ? rate.price : null, usdJpyAsOf: rate ? rate.asOf : null };
}

export function valueHoldings(
  lots: HoldLot[],
  priceMap: Map<string, DisplayPrice>,
  usdJpy: number | null,
): Valuation {
  let valuation = 0;
  let cost = 0;
  let stale = false;
  const per = new Map<string, SymbolBreakdown>();

  for (const lot of lots) {
    const buyRate = lot.market === 'JP' ? 1 : lot.buy_rate > 0 ? lot.buy_rate : (usdJpy ?? 1);
    const lotCost = Math.floor(lot.buy_price * lot.quantity * buyRate * 100);
    cost += lotCost;

    const dp = priceMap.get(lot.symbol);
    const nowRate = lot.market === 'JP' ? 1 : usdJpy ?? buyRate;
    if (!dp || (lot.market === 'US' && usdJpy === null)) stale = true;
    const lotValuation = Math.floor((dp ? dp.price : lot.buy_price) * lot.quantity * nowRate * 100);
    valuation += lotValuation;

    const b = per.get(lot.symbol) ?? {
      symbol: lot.symbol,
      market: lot.market,
      quantity: 0,
      costJpyC: 0,
      valuationJpyC: 0,
      price: dp ? dp.price : null,
      asOf: dp ? dp.asOf : null,
    };
    b.quantity += lot.quantity;
    b.costJpyC += lotCost;
    b.valuationJpyC += lotValuation;
    per.set(lot.symbol, b);
  }

  return {
    valuationJpyC: valuation,
    costJpyC: cost,
    unrealizedJpyC: valuation - cost,
    stale,
    bySymbol: [...per.values()],
  };
}

/** 総資産(円換算) = 円残高 + USD残高×為替 + 評価額 */
export function totalAssetsJpyC(cashJpyC: number, cashUsdC: number, usdJpy: number, valuationJpyC: number): number {
  return cashJpyC + Math.floor(cashUsdC * usdJpy) + valuationJpyC;
}
