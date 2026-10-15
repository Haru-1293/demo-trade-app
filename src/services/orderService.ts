import type { Env, Market, OrderRow } from '../types';
import {
  currencyOf,
  settlementCurrencyOf,
  tryDeductCash,
  toAmountC,
  lockSellableQuantity,
  selectFifoLotsForSale,
  buildSellStatements,
} from './balance';
import { getCurrentPrice, getUsdJpyRate } from './marketData';
import { timeZoneOf, localEndOfDayToUnix, isWithinExpiryRange } from './timezone';

/**
 * 注文の実処理（仕様書4.2 / 4.3 / 4.9）。Web画面の `/api/orders/*`（routes/orders.ts）と
 * MCPのツール（mcp/tools.ts、仕様書4.18）が同じ処理を使う。
 * HTTPのステータスと本文の組を返すだけで、HonoのContextには依存しない。
 */
export interface OrderResult {
  status: number;
  body: Record<string, unknown>;
}

type SettlementCurrency = 'NATIVE' | 'JPY';

interface MarketOrderBody {
  code: string;
  market: Market;
  side: 'BUY' | 'SELL';
  quantity: number;
  idempotency_key: string;
  /** 米国株の買いのみ有効。円貨決済する場合は'JPY'（仕様書4.9）。省略時はNATIVE。 */
  settlement_currency?: SettlementCurrency;
}

interface LimitOrderBody extends MarketOrderBody {
  order_type: 'BUY_LIMIT' | 'SELL_LIMIT';
  target_price: number;
  expires_date: string; // YYYY-MM-DD（取引所現地日付、仕様書4.3）
}

const fail = (status: number, error: string): OrderResult => ({ status, body: { error } });

// 冪等性キーは「自分の注文」の中だけで照合する（他人の注文が返ってしまう情報漏えいを防ぐ）
async function findExistingOrder(db: D1Database, userId: string, idempotencyKey: string) {
  return db
    .prepare(`SELECT * FROM orders WHERE idempotency_key = ? AND user_id = ?`)
    .bind(idempotencyKey, userId)
    .first();
}

const MAX_ORDER_QUANTITY = 1_000_000_000;

/** 注文本文の共通検証。問題があればエラーメッセージを返す */
function validateOrderBody(body: {
  market?: unknown; code?: unknown; quantity?: unknown; idempotency_key?: unknown;
}): string | null {
  if (body.market !== 'JP' && body.market !== 'US') return 'invalid market';
  if (typeof body.code !== 'string' || !body.code || body.code.length > 20) return 'invalid code';
  if (!Number.isInteger(body.quantity) || (body.quantity as number) <= 0 || (body.quantity as number) > MAX_ORDER_QUANTITY) {
    return 'invalid quantity';
  }
  if (typeof body.idempotency_key !== 'string' || !body.idempotency_key || body.idempotency_key.length > 100) {
    return 'idempotency_key required';
  }
  return null;
}

function cashColumn(currency: 'JPY' | 'USD'): string {
  return currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';
}

function validateSettlementCurrency(market: Market, settlement?: SettlementCurrency): string | null {
  if (settlement === 'JPY' && market !== 'US') {
    return '円貨決済は米国株の買い注文のみ指定できます';
  }
  return null;
}

/**
 * 成行注文 — 仕様書4.2 / 4.9
 * 全量約定 or 却下のみ（部分約定なし）。空売り非対応。
 */
export async function placeMarketOrder(env: Env, userId: string, input: unknown): Promise<OrderResult> {
  const body = input as MarketOrderBody | null;
  if (!body || typeof body !== 'object') return fail(400, 'invalid body');

  const bodyError = validateOrderBody(body);
  if (bodyError) return fail(400, bodyError);
  if (body.side !== 'BUY' && body.side !== 'SELL') return fail(400, 'invalid side');

  const settlementError = validateSettlementCurrency(body.market, body.settlement_currency);
  if (settlementError) return fail(400, settlementError);

  const existing = await findExistingOrder(env.DB, userId, body.idempotency_key);
  if (existing) return { status: 200, body: { order: existing } };

  const symbolRow = await env.DB.prepare(
    `SELECT * FROM symbols WHERE code = ? AND market = ? AND active = 1`,
  )
    .bind(body.code, body.market)
    .first<{ symbol: string; name: string; currency: 'JPY' | 'USD' }>();
  if (!symbolRow) return fail(400, 'symbol not found');

  const quote = await getCurrentPrice(env, symbolRow.symbol);
  if (!quote) return fail(503, 'market data unavailable');

  // rateはprofit_jpy_c算出やtrades.buy_rate保存のための為替レート（米国株のみ取得）。
  // 決済実額の計算には使わない（下記settlementRateで区別する）。
  const rate = symbolRow.currency === 'USD' ? (await getUsdJpyRate(env))?.price ?? null : 1;
  if (rate == null) return fail(503, 'fx data unavailable');

  const settlement = body.settlement_currency === 'JPY' ? 'JPY' : 'NATIVE';
  const settlementCurrency = settlementCurrencyOf(body.market, settlement);
  // 円貨決済なら円換算レート、そうでなければ1（銘柄本来通貨のまま＝実額）
  const settlementRate = settlement === 'JPY' ? rate : 1;

  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  const orderId = crypto.randomUUID();

  if (body.side === 'BUY') {
    const slippage = Number(env.SLIPPAGE_SAFETY_FACTOR || '1.05');
    const requiredC = toAmountC(quote.price * slippage, body.quantity, settlementRate);

    const checkOk = await tryDeductCash(env.DB, userId, settlementCurrency, requiredC);
    if (!checkOk) {
      await env.DB.prepare(
        `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
           target_price, quantity, locked_amount_c, settlement_currency, ordered_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'BUY_MARKET', NULL, ?, 0, ?, ?, 'REJECTED')`,
      )
        .bind(orderId, userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.quantity, settlement, now)
        .run();
      return fail(400, 'insufficient funds');
    }

    const actualC = toAmountC(quote.price, body.quantity, settlementRate);
    const refundC = requiredC - actualC; // 安全係数分の差額は実額確定後ただちに返却（仕様書4.2）
    const tradeId = crypto.randomUUID();

    const stmts = [
      env.DB.prepare(
        `INSERT INTO trades (id, user_id, code, symbol, name, market, quantity, locked_quantity,
           buy_date, buy_price, buy_rate, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'HOLD')`,
      ).bind(tradeId, userId, body.code, symbolRow.symbol, symbolRow.name, body.market, body.quantity, today, quote.price, rate),
      env.DB.prepare(
        `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
           target_price, quantity, locked_amount_c, settlement_currency, ordered_at, status, executed_price, executed_at, executed_rate)
         VALUES (?, ?, ?, ?, ?, ?, 'BUY_MARKET', NULL, ?, 0, ?, ?, 'EXECUTED', ?, ?, ?)`,
      ).bind(orderId, userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.quantity, settlement, now, quote.price, now, rate),
    ];
    if (refundC > 0) {
      const column = cashColumn(settlementCurrency);
      stmts.push(
        env.DB.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE id = ?`).bind(refundC, userId),
      );
    }
    await env.DB.batch(stmts);

    return { status: 201, body: { order_id: orderId, status: 'EXECUTED', executed_price: quote.price } };
  } else {
    // SELL_MARKET: 空売り非対応。売却可能株数を超える注文は却下。受取通貨は常に銘柄本来通貨。
    const selection = await selectFifoLotsForSale(env.DB, userId, body.code, body.market, body.quantity);
    if (!selection) {
      await env.DB.prepare(
        `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
           target_price, quantity, locked_amount_c, ordered_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'SELL_MARKET', NULL, ?, 0, ?, 'REJECTED')`,
      )
        .bind(orderId, userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.quantity, now)
        .run();
      return fail(400, 'insufficient sellable quantity');
    }

    const { stmts: sellStmts, proceedsC } = buildSellStatements(
      env.DB,
      selection.lots,
      selection.plan,
      today,
      quote.price,
      rate,
    );
    const currency = currencyOf(body.market);
    const column = cashColumn(currency);

    const stmts = [
      ...sellStmts,
      env.DB.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE id = ?`).bind(proceedsC, userId),
      env.DB.prepare(
        `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
           target_price, quantity, locked_amount_c, ordered_at, status, executed_price, executed_at, executed_rate)
         VALUES (?, ?, ?, ?, ?, ?, 'SELL_MARKET', NULL, ?, 0, ?, 'EXECUTED', ?, ?, ?)`,
      ).bind(orderId, userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.quantity, now, quote.price, now, rate),
    ];
    await env.DB.batch(stmts);

    return { status: 201, body: { order_id: orderId, status: 'EXECUTED', executed_price: quote.price } };
  }
}

/**
 * 指値注文 — 仕様書4.3 / 4.9
 * 有効期限は取引所現地日付で指定、最大14日先。指定日の現地23:59:59をUTC秒に変換して保存。
 *
 * 円貨決済(BUY_LIMIT)の為替レートは「指値どおりの価格で約定する」という既存原則にならい、
 * 注文時点のレートで円換算額を確定・固定する（約定時点のレートでの再計算は行わない）。
 * これにより不成立(EXPIRED/CANCELLED)時は、ロックした円をそのまま返すだけで済む。
 */
export async function placeLimitOrder(env: Env, userId: string, input: unknown): Promise<OrderResult> {
  const body = input as LimitOrderBody | null;
  if (!body || typeof body !== 'object') return fail(400, 'invalid body');

  const bodyError = validateOrderBody(body);
  if (bodyError) return fail(400, bodyError);
  if (body.order_type !== 'BUY_LIMIT' && body.order_type !== 'SELL_LIMIT') {
    return fail(400, 'invalid order_type');
  }
  if (typeof body.target_price !== 'number' || !Number.isFinite(body.target_price) || !(body.target_price > 0) || body.target_price > 1e9) {
    return fail(400, 'invalid target_price');
  }
  if (typeof body.expires_date !== 'string') return fail(400, 'invalid expires_date');

  const settlementError = validateSettlementCurrency(body.market, body.settlement_currency);
  if (settlementError) return fail(400, settlementError);

  const existing = await findExistingOrder(env.DB, userId, body.idempotency_key);
  if (existing) return { status: 200, body: { order: existing } };

  const symbolRow = await env.DB.prepare(
    `SELECT * FROM symbols WHERE code = ? AND market = ? AND active = 1`,
  )
    .bind(body.code, body.market)
    .first<{ symbol: string; currency: 'JPY' | 'USD' }>();
  if (!symbolRow) return fail(400, 'symbol not found');

  const now = Math.floor(Date.now() / 1000);
  const tz = timeZoneOf(body.market);
  const maxDays = Number(env.ORDER_EXPIRY_MAX_DAYS || '14');

  if (!isWithinExpiryRange(body.expires_date, tz, now, maxDays)) {
    return fail(400, `有効期限は当日から${maxDays}日先までの日付で指定してください`);
  }
  const expiresAt = localEndOfDayToUnix(body.expires_date, tz);
  const orderId = crypto.randomUUID();

  if (body.order_type === 'BUY_LIMIT') {
    const settlement = body.settlement_currency === 'JPY' ? 'JPY' : 'NATIVE';
    const settlementCurrency = settlementCurrencyOf(body.market, settlement);

    let settlementRate = 1;
    if (settlement === 'JPY' || symbolRow.currency === 'USD') {
      const fx = await getUsdJpyRate(env);
      if (!fx) return fail(503, 'fx data unavailable');
      if (settlement === 'JPY') settlementRate = fx.price; // 円貨決済: 注文時点レートで固定
      // NATIVE決済の場合は settlementRate=1 のまま（実額のみロック。為替レートはtrades保存用に別途使わない）
    }

    const requiredC = toAmountC(body.target_price, body.quantity, settlementRate);
    const ok = await tryDeductCash(env.DB, userId, settlementCurrency, requiredC);
    if (!ok) return fail(400, 'insufficient funds');

    await env.DB.prepare(
      `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
         target_price, quantity, locked_amount_c, settlement_currency, ordered_at, expires_at, checked_until, status)
       VALUES (?, ?, ?, ?, ?, ?, 'BUY_LIMIT', ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    )
      .bind(orderId, userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.target_price, body.quantity, requiredC, settlement, now, expiresAt, now)
      .run();

    return { status: 201, body: { order_id: orderId, status: 'PENDING' } };
  } else {
    // SELL_LIMIT: 空売り非対応。全量ロックできなければ却下。受取通貨は常に銘柄本来通貨。
    const lockPlan = await lockSellableQuantity(env.DB, userId, body.code, body.market, body.quantity);
    if (!lockPlan) return fail(400, 'insufficient sellable quantity');

    await env.DB.prepare(
      `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
         target_price, quantity, locked_amount_c, locked_lots, ordered_at, expires_at, checked_until, status)
       VALUES (?, ?, ?, ?, ?, ?, 'SELL_LIMIT', ?, ?, 0, ?, ?, ?, ?, 'PENDING')`,
    )
      .bind(orderId, userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.target_price, body.quantity, JSON.stringify(lockPlan), now, expiresAt, now)
      .run();

    return { status: 201, body: { order_id: orderId, status: 'PENDING' } };
  }
}

/**
 * 注文の取消 — 仕様書4.3 / 4.9
 *
 * v2.9: 同じ注文を同時に2回取り消しても、資金・株数の返却が二重にならないようにした。
 * 状態の更新は `WHERE status = 'PENDING'` に限り、返却の各文は直前の文が実際に行を変更した
 * （SQLiteの `changes() > 0`）ときだけ実行する。D1のbatchは1つのトランザクションで順に実行される。
 */
export async function cancelOrder(env: Env, userId: string, orderId: string): Promise<OrderResult> {
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ?`)
    .bind(orderId, userId)
    .first<OrderRow>();
  if (!order) return fail(404, 'not found');
  if (order.status !== 'PENDING') return fail(400, 'order is not cancellable');

  const stmts = [
    env.DB.prepare(`UPDATE orders SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING'`).bind(order.id),
  ];

  if (order.order_type === 'BUY_LIMIT' && order.locked_amount_c > 0) {
    // 円貨決済(settlement_currency='JPY')ならJPYで返却、それ以外は銘柄本来通貨で返却（仕様書4.9）
    const currency = settlementCurrencyOf(order.market, order.settlement_currency);
    const column = cashColumn(currency);
    stmts.push(
      env.DB.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE id = ? AND changes() > 0`).bind(order.locked_amount_c, userId),
    );
  } else if (order.order_type === 'SELL_LIMIT' && order.locked_lots) {
    const plan = JSON.parse(order.locked_lots) as { tradeId: string; lockQty: number }[];
    for (const { tradeId, lockQty } of plan) {
      stmts.push(
        env.DB.prepare(`UPDATE trades SET locked_quantity = locked_quantity - ? WHERE id = ? AND changes() > 0`).bind(lockQty, tradeId),
      );
    }
  }

  await env.DB.batch(stmts);
  return { status: 200, body: { ok: true } };
}
