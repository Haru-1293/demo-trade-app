import type { Env } from '../types';
import { getDisplayPrices, type DisplayPrice } from './marketData';
import { settlementCurrencyOf } from './balance';

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

/** 指値買いの未約定注文（PENDING）が拘束している資金（通貨ごと、銭・セント単位） */
export interface LockedFunds {
  jpyC: number;
  usdC: number;
}

/**
 * 未約定の指値買いが拘束している資金を集計する（仕様書4.3 / 4.9）。userId省略時は全ユーザー分。
 * 注文時に現金から差し引かれているので、総資産には含めて数える（約定すれば保有株、取消・期限切れなら現金に戻るお金）。
 * 円貨決済の米国株買いは円で拘束している。
 */
export async function fetchLockedFunds(db: D1Database, userId?: string): Promise<Map<string, LockedFunds>> {
  const { results } = await db
    .prepare(
      `SELECT user_id, market, settlement_currency, SUM(locked_amount_c) AS amount
         FROM orders WHERE status = 'PENDING' AND order_type = 'BUY_LIMIT' ${userId ? 'AND user_id = ?' : ''}
        GROUP BY user_id, market, settlement_currency`,
    )
    .bind(...(userId ? [userId] : []))
    .all<{ user_id: string; market: 'JP' | 'US'; settlement_currency: 'NATIVE' | 'JPY'; amount: number }>();
  const out = new Map<string, LockedFunds>();
  for (const r of results ?? []) {
    const f = out.get(r.user_id) ?? { jpyC: 0, usdC: 0 };
    if (settlementCurrencyOf(r.market, r.settlement_currency) === 'JPY') f.jpyC += r.amount;
    else f.usdC += r.amount;
    out.set(r.user_id, f);
  }
  return out;
}

/** 総資産(円換算) = (円残高 + 拘束中の円) + (USD残高 + 拘束中のUSD)×為替 + 評価額 */
export function totalAssetsJpyC(
  cashJpyC: number,
  cashUsdC: number,
  usdJpy: number,
  valuationJpyC: number,
  locked: LockedFunds = { jpyC: 0, usdC: 0 },
): number {
  return cashJpyC + locked.jpyC + Math.floor((cashUsdC + locked.usdC) * usdJpy) + valuationJpyC;
}
