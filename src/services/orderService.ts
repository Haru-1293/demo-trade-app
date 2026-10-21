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
import { verifyOrderBeforeChange } from './limitCheck';
import { orderStateGuard, requireChangesGuard, sellableCapacityGuard, isStateChangedError } from './orderGuard';

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
    // 取消の間に注文が修正・約定されていたら、古い拘束額を返してしまわないよう全体を巻き戻す
    orderStateGuard(env.DB, order),
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

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (!isStateChangedError(e)) throw e;
    const now = await env.DB.prepare(`SELECT status FROM orders WHERE id = ?`).bind(order.id).first<{ status: string }>();
    return now?.status === 'PENDING'
      ? fail(409, 'order was changed; please retry')
      : fail(400, 'order is not cancellable');
  }
  return { status: 200, body: { ok: true } };
}

interface LockPlanEntry { tradeId: string; lockQty: number }

/**
 * 未約定の指値注文の修正 — 仕様書4.3.1
 * 変えられるのは、指値価格(target_price)・数量(quantity)・有効期限(expires_date)。銘柄・売買の方向・決済通貨は変えられない
 * （変えたいときは取り消して出し直す）。
 *
 * - 修正の前に、前回の判定以降の値動きを、修正前の条件で判定する。すでに約定・期限切れなら修正できない。
 *   値動きのデータを取れないときは、判定を済ませないまま条件を変えられるのを防ぐため、修正を断る（503）。
 * - 修正後の条件は、修正した時点から先の値動きだけで判定する（checked_until を現在時刻にする）。
 * - 買い: 拘束額(locked_amount_c)を「新しい指値×数量」に合わせ、差額だけ現金から追加で拘束／返却する。
 *   円貨決済の米国株は、為替レートを修正時点のレートで固定し直す。
 * - 売り: 数量を増やすときは売却可能株数からFIFOで追加ロックし、減らすときはロックの後ろから解除する。
 * すべて1つのbatch（トランザクション）で行い、先頭の状態確認で、その間に注文が変わっていたら全体を巻き戻す。
 */
export async function modifyLimitOrder(env: Env, userId: string, orderId: string, input: unknown): Promise<OrderResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'invalid body');
  const body = input as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (k !== 'target_price' && k !== 'quantity' && k !== 'expires_date') return fail(400, `cannot modify: ${k.slice(0, 40)}`);
  }
  if (body.target_price === undefined && body.quantity === undefined && body.expires_date === undefined) {
    return fail(400, 'nothing to modify');
  }
  if (body.target_price !== undefined) {
    const p = body.target_price;
    if (typeof p !== 'number' || !Number.isFinite(p) || !(p > 0) || p > 1e9) return fail(400, 'invalid target_price');
  }
  if (body.quantity !== undefined) {
    const q = body.quantity;
    if (!Number.isInteger(q) || (q as number) <= 0 || (q as number) > MAX_ORDER_QUANTITY) return fail(400, 'invalid quantity');
  }
  if (body.expires_date !== undefined && typeof body.expires_date !== 'string') return fail(400, 'invalid expires_date');

  const first = await env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ?`).bind(orderId, userId).first<OrderRow>();
  if (!first) return fail(404, 'not found');
  if (first.status !== 'PENDING' || (first.order_type !== 'BUY_LIMIT' && first.order_type !== 'SELL_LIMIT')) {
    return fail(400, 'order is not modifiable');
  }

  const verdict = await verifyOrderBeforeChange(env, first);
  if (verdict === 'gone') return fail(409, 'order is no longer pending (executed or expired)');
  if (verdict === 'unverified') return fail(503, 'market data unavailable; try again later');

  // 判定で更新された可能性があるので、最新の内容を読み直す
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ?`).bind(orderId, userId).first<OrderRow>();
  if (!order || order.status !== 'PENDING') return fail(409, 'order is no longer pending (executed or expired)');

  const now = Math.floor(Date.now() / 1000);
  const newPrice = (body.target_price as number | undefined) ?? (order.target_price as number);
  const newQty = (body.quantity as number | undefined) ?? order.quantity;
  let newExpiresAt = order.expires_at;
  if (body.expires_date !== undefined) {
    const tz = timeZoneOf(order.market);
    const maxDays = Number(env.ORDER_EXPIRY_MAX_DAYS || '14');
    if (!isWithinExpiryRange(body.expires_date as string, tz, now, maxDays)) {
      return fail(400, `有効期限は当日から${maxDays}日先までの日付で指定してください`);
    }
    newExpiresAt = localEndOfDayToUnix(body.expires_date as string, tz);
  }
  if (newPrice === order.target_price && newQty === order.quantity && newExpiresAt === order.expires_at) {
    return fail(400, 'no changes');
  }

  const db = env.DB;
  const stmts: D1PreparedStatement[] = [orderStateGuard(db, order)];
  let newLockedC = order.locked_amount_c;
  let newLockedLots = order.locked_lots;

  if (order.order_type === 'BUY_LIMIT') {
    if (newPrice !== order.target_price || newQty !== order.quantity) {
      let rate = 1;
      if (order.settlement_currency === 'JPY') {
        const fx = await getUsdJpyRate(env);
        if (!fx) return fail(503, 'fx data unavailable');
        rate = fx.price; // 円貨決済: 修正時点のレートで固定し直す
      }
      newLockedC = toAmountC(newPrice, newQty, rate);
    }
    const delta = newLockedC - order.locked_amount_c;
    const column = cashColumn(settlementCurrencyOf(order.market, order.settlement_currency));
    if (delta > 0) {
      stmts.push(
        db.prepare(`UPDATE users SET ${column} = ${column} - ?, updated_at = ? WHERE id = ? AND ${column} >= ?`).bind(delta, now, userId, delta),
        requireChangesGuard(db), // 残高不足なら全体を巻き戻す
      );
    } else if (delta < 0) {
      stmts.push(db.prepare(`UPDATE users SET ${column} = ${column} + ?, updated_at = ? WHERE id = ?`).bind(-delta, now, userId));
    }
  } else if (newQty !== order.quantity) {
    // SELL_LIMIT: 株数のロックを増減する
    const plan: LockPlanEntry[] = order.locked_lots ? (JSON.parse(order.locked_lots) as LockPlanEntry[]).map((p) => ({ ...p })) : [];
    if (!plan.length) return fail(500, 'order lock data is missing');
    if (newQty < order.quantity) {
      let release = order.quantity - newQty;
      for (let i = plan.length - 1; i >= 0 && release > 0; i--) {
        const take = Math.min(plan[i]!.lockQty, release);
        plan[i]!.lockQty -= take;
        release -= take;
        stmts.push(db.prepare(`UPDATE trades SET locked_quantity = locked_quantity - ? WHERE id = ?`).bind(take, plan[i]!.tradeId));
      }
    } else {
      const { results } = await db
        .prepare(
          `SELECT id, quantity, locked_quantity FROM trades
            WHERE user_id = ? AND code = ? AND market = ? AND status = 'HOLD' AND quantity > locked_quantity
            ORDER BY buy_date ASC`,
        )
        .bind(userId, order.code, order.market)
        .all<{ id: string; quantity: number; locked_quantity: number }>();
      let need = newQty - order.quantity;
      for (const row of results ?? []) {
        if (need <= 0) break;
        const take = Math.min(row.quantity - row.locked_quantity, need);
        if (take <= 0) continue;
        need -= take;
        const existing = plan.find((p) => p.tradeId === row.id);
        if (existing) existing.lockQty += take;
        else plan.push({ tradeId: row.id, lockQty: take });
        stmts.push(
          sellableCapacityGuard(db, row.id, take), // 他の注文が先にロックして足りなくなっていたら全体を巻き戻す
          db.prepare(`UPDATE trades SET locked_quantity = locked_quantity + ? WHERE id = ?`).bind(take, row.id),
        );
      }
      if (need > 0) return fail(400, 'insufficient sellable quantity');
    }
    newLockedLots = JSON.stringify(plan.filter((p) => p.lockQty > 0));
  }

  // checked_until を現在時刻にして、修正後の条件は、いまから先の値動きだけで判定する
  stmts.push(
    db
      .prepare(
        `UPDATE orders SET target_price = ?, quantity = ?, locked_amount_c = ?, locked_lots = ?, expires_at = ?, checked_until = ?
          WHERE id = ? AND user_id = ? AND status = 'PENDING'`,
      )
      .bind(newPrice, newQty, newLockedC, newLockedLots, newExpiresAt, now, order.id, userId),
  );

  try {
    await db.batch(stmts);
  } catch (e) {
    if (!isStateChangedError(e)) throw e;
    // 状態確認の失敗（別の処理が注文を変えた）か、残高不足による巻き戻しかを、読み直して見分ける
    const cur = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(order.id).first<OrderRow>();
    const same = cur && cur.status === 'PENDING' && cur.quantity === order.quantity && cur.target_price === order.target_price &&
      cur.locked_amount_c === order.locked_amount_c && cur.expires_at === order.expires_at;
    if (same) return fail(400, order.order_type === 'BUY_LIMIT' ? 'insufficient funds' : 'insufficient sellable quantity');
    return fail(409, 'order was changed; please retry');
  }

  const updated = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(order.id).first();
  return { status: 200, body: { ok: true, order: updated } };
}
