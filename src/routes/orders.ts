import { Hono } from 'hono';
import type { Env, Market, OrderRow } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import {
  currencyOf,
  tryDeductCash,
  toAmountC,
  lockSellableQuantity,
  selectFifoLotsForSale,
  buildSellStatements,
} from '../services/balance';
import { getCurrentPrice, getUsdJpyRate } from '../services/marketData';
import { timeZoneOf, localEndOfDayToUnix, isWithinExpiryRange } from '../services/timezone';

const app = new Hono<{ Bindings: Env }>();

interface MarketOrderBody {
  code: string;
  market: Market;
  side: 'BUY' | 'SELL';
  quantity: number;
  idempotency_key: string;
}

async function findExistingOrder(db: D1Database, idempotencyKey: string) {
  return db.prepare(`SELECT * FROM orders WHERE idempotency_key = ?`).bind(idempotencyKey).first();
}

/**
 * POST /api/orders/market — 仕様書4.2
 * 全量約定 or 却下のみ（部分約定なし）。空売り非対応。
 */
app.post('/orders/market', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<MarketOrderBody>();

  if (!Number.isInteger(body.quantity) || body.quantity <= 0) {
    return c.json({ error: 'invalid quantity' }, 400);
  }
  if (!body.idempotency_key) return c.json({ error: 'idempotency_key required' }, 400);

  const existing = await findExistingOrder(c.env.DB, body.idempotency_key);
  if (existing) return c.json({ order: existing });

  const symbolRow = await c.env.DB.prepare(
    `SELECT * FROM symbols WHERE code = ? AND market = ? AND active = 1`,
  )
    .bind(body.code, body.market)
    .first<{ symbol: string; name: string; currency: 'JPY' | 'USD' }>();
  if (!symbolRow) return c.json({ error: 'symbol not found' }, 400);

  const quote = await getCurrentPrice(c.env, symbolRow.symbol);
  if (!quote) return c.json({ error: 'market data unavailable' }, 503);

  const rate = symbolRow.currency === 'USD' ? (await getUsdJpyRate(c.env))?.price ?? null : 1;
  if (rate == null) return c.json({ error: 'fx data unavailable' }, 503);

  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  const orderId = crypto.randomUUID();

  if (body.side === 'BUY') {
    const slippage = Number(c.env.SLIPPAGE_SAFETY_FACTOR || '1.05');
    const requiredC = toAmountC(quote.price * slippage, body.quantity, rate);
    const currency = currencyOf(body.market);

    const checkOk = await tryDeductCash(c.env.DB, auth.userId, currency, requiredC);
    if (!checkOk) {
      await c.env.DB.prepare(
        `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
           target_price, quantity, locked_amount_c, ordered_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'BUY_MARKET', NULL, ?, 0, ?, 'REJECTED')`,
      )
        .bind(orderId, auth.userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.quantity, now)
        .run();
      return c.json({ error: 'insufficient funds' }, 400);
    }

    const actualC = toAmountC(quote.price, body.quantity, rate);
    const refundC = requiredC - actualC; // 安全係数分の差額は実額確定後ただちに返却（仕様書4.2）
    const tradeId = crypto.randomUUID();

    const stmts = [
      c.env.DB.prepare(
        `INSERT INTO trades (id, user_id, code, symbol, name, market, quantity, locked_quantity,
           buy_date, buy_price, buy_rate, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'HOLD')`,
      ).bind(tradeId, auth.userId, body.code, symbolRow.symbol, symbolRow.name, body.market, body.quantity, today, quote.price, rate),
      c.env.DB.prepare(
        `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
           target_price, quantity, locked_amount_c, ordered_at, status, executed_price, executed_at, executed_rate)
         VALUES (?, ?, ?, ?, ?, ?, 'BUY_MARKET', NULL, ?, 0, ?, 'EXECUTED', ?, ?, ?)`,
      ).bind(orderId, auth.userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.quantity, now, quote.price, now, rate),
    ];
    if (refundC > 0) {
      const column = currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';
      stmts.push(
        c.env.DB.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE id = ?`).bind(refundC, auth.userId),
      );
    }
    await c.env.DB.batch(stmts);

    return c.json({ order_id: orderId, status: 'EXECUTED', executed_price: quote.price }, 201);
  } else {
    // SELL_MARKET: 空売り非対応。売却可能株数を超える注文は却下。
    const selection = await selectFifoLotsForSale(c.env.DB, auth.userId, body.code, body.market, body.quantity);
    if (!selection) {
      await c.env.DB.prepare(
        `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
           target_price, quantity, locked_amount_c, ordered_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'SELL_MARKET', NULL, ?, 0, ?, 'REJECTED')`,
      )
        .bind(orderId, auth.userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.quantity, now)
        .run();
      return c.json({ error: 'insufficient sellable quantity' }, 400);
    }

    const { stmts: sellStmts, proceedsC } = buildSellStatements(
      c.env.DB,
      selection.lots,
      selection.plan,
      today,
      quote.price,
      rate,
    );
    const currency = currencyOf(body.market);
    const column = currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';

    const stmts = [
      ...sellStmts,
      c.env.DB.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE id = ?`).bind(proceedsC, auth.userId),
      c.env.DB.prepare(
        `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
           target_price, quantity, locked_amount_c, ordered_at, status, executed_price, executed_at, executed_rate)
         VALUES (?, ?, ?, ?, ?, ?, 'SELL_MARKET', NULL, ?, 0, ?, 'EXECUTED', ?, ?, ?)`,
      ).bind(orderId, auth.userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.quantity, now, quote.price, now, rate),
    ];
    await c.env.DB.batch(stmts);

    return c.json({ order_id: orderId, status: 'EXECUTED', executed_price: quote.price }, 201);
  }
});

interface LimitOrderBody extends MarketOrderBody {
  order_type: 'BUY_LIMIT' | 'SELL_LIMIT';
  target_price: number;
  expires_date: string; // YYYY-MM-DD（取引所現地日付、仕様書4.3）
}

/**
 * POST /api/orders/limit — 仕様書4.3
 * 有効期限は取引所現地日付で指定、最大14日先。指定日の現地23:59:59をUTC秒に変換して保存。
 */
app.post('/orders/limit', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<LimitOrderBody>();

  if (!Number.isInteger(body.quantity) || body.quantity <= 0) {
    return c.json({ error: 'invalid quantity' }, 400);
  }
  if (!body.idempotency_key) return c.json({ error: 'idempotency_key required' }, 400);
  if (!(body.target_price > 0)) return c.json({ error: 'invalid target_price' }, 400);

  const existing = await findExistingOrder(c.env.DB, body.idempotency_key);
  if (existing) return c.json({ order: existing });

  const symbolRow = await c.env.DB.prepare(
    `SELECT * FROM symbols WHERE code = ? AND market = ? AND active = 1`,
  )
    .bind(body.code, body.market)
    .first<{ symbol: string; currency: 'JPY' | 'USD' }>();
  if (!symbolRow) return c.json({ error: 'symbol not found' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const tz = timeZoneOf(body.market);
  const maxDays = Number(c.env.ORDER_EXPIRY_MAX_DAYS || '14');

  if (!isWithinExpiryRange(body.expires_date, tz, now, maxDays)) {
    return c.json({ error: `有効期限は当日から${maxDays}日先までの日付で指定してください` }, 400);
  }
  const expiresAt = localEndOfDayToUnix(body.expires_date, tz);
  const orderId = crypto.randomUUID();

  if (body.order_type === 'BUY_LIMIT') {
    const rate = symbolRow.currency === 'USD' ? (await getUsdJpyRate(c.env))?.price ?? null : 1;
    if (rate == null) return c.json({ error: 'fx data unavailable' }, 503);

    const requiredC = toAmountC(body.target_price, body.quantity, rate);
    const currency = currencyOf(body.market);
    const ok = await tryDeductCash(c.env.DB, auth.userId, currency, requiredC);
    if (!ok) return c.json({ error: 'insufficient funds' }, 400);

    await c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
         target_price, quantity, locked_amount_c, ordered_at, expires_at, checked_until, status)
       VALUES (?, ?, ?, ?, ?, ?, 'BUY_LIMIT', ?, ?, ?, ?, ?, ?, 'PENDING')`,
    )
      .bind(orderId, auth.userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.target_price, body.quantity, requiredC, now, expiresAt, now)
      .run();

    return c.json({ order_id: orderId, status: 'PENDING' }, 201);
  } else {
    // SELL_LIMIT: 空売り非対応。全量ロックできなければ却下。
    const lockPlan = await lockSellableQuantity(c.env.DB, auth.userId, body.code, body.market, body.quantity);
    if (!lockPlan) return c.json({ error: 'insufficient sellable quantity' }, 400);

    await c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, idempotency_key, code, symbol, market, order_type,
         target_price, quantity, locked_amount_c, locked_lots, ordered_at, expires_at, checked_until, status)
       VALUES (?, ?, ?, ?, ?, ?, 'SELL_LIMIT', ?, ?, 0, ?, ?, ?, ?, 'PENDING')`,
    )
      .bind(orderId, auth.userId, body.idempotency_key, body.code, symbolRow.symbol, body.market, body.target_price, body.quantity, JSON.stringify(lockPlan), now, expiresAt, now)
      .run();

    return c.json({ order_id: orderId, status: 'PENDING' }, 201);
  }
});

/** POST /api/orders/:id/cancel — 仕様書4.3 */
app.post('/orders/:id/cancel', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const orderId = c.req.param('id');

  const order = await c.env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ?`)
    .bind(orderId, auth.userId)
    .first<OrderRow>();
  if (!order) return c.json({ error: 'not found' }, 404);
  if (order.status !== 'PENDING') return c.json({ error: 'order is not cancellable' }, 400);

  const stmts = [
    c.env.DB.prepare(`UPDATE orders SET status = 'CANCELLED' WHERE id = ?`).bind(order.id),
  ];

  if (order.order_type === 'BUY_LIMIT' && order.locked_amount_c > 0) {
    const currency = currencyOf(order.market);
    const column = currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';
    stmts.push(
      c.env.DB.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE id = ?`).bind(order.locked_amount_c, auth.userId),
    );
  } else if (order.order_type === 'SELL_LIMIT' && order.locked_lots) {
    const plan = JSON.parse(order.locked_lots) as { tradeId: string; lockQty: number }[];
    for (const { tradeId, lockQty } of plan) {
      stmts.push(
        c.env.DB.prepare(`UPDATE trades SET locked_quantity = locked_quantity - ? WHERE id = ?`).bind(lockQty, tradeId),
      );
    }
  }

  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

export default app;
