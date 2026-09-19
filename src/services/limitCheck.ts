import type { Env, OrderRow } from '../types';
import { getOhlcHistory, getUsdJpyRate } from './marketData';
import { currencyOf, settlementCurrencyOf, buildSellStatements, type HoldLot } from './balance';

/**
 * 仕様書 4.4: ユーザーのアクセス（ログイン/portfolio/orders取得）をトリガーに、
 * PENDING状態の指値注文をバックグラウンドで約定判定する。
 */
export async function checkPendingLimitOrders(env: Env, userId: string): Promise<void> {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const { results } = await db
    .prepare(`SELECT * FROM orders WHERE user_id = ? AND status = 'PENDING'`)
    .bind(userId)
    .all<OrderRow>();

  for (const order of results ?? []) {
    await checkOneOrder(env, order, now);
  }
}

async function checkOneOrder(env: Env, order: OrderRow, now: number): Promise<void> {
  const db = env.DB;
  // 期限切れ判定を先に行う
  if (order.expires_at != null && now >= order.expires_at) {
    await expireOrder(db, order);
    return;
  }

  const from = order.checked_until ?? order.ordered_at;
  const to = Math.min(now, order.expires_at ?? now);
  if (from >= to) return;

  const ohlc = await getOhlcHistory(order.symbol, from, to);

  if (!ohlc || ohlc.length === 0) {
    // データ取得不可: checked_untilは更新せず、次回アクセス時に再取得を試みる
    return;
  }

  const low = Math.min(...ohlc.map((p) => p.low));
  const high = Math.max(...ohlc.map((p) => p.high));
  const targetPrice = order.target_price ?? 0;

  const executed =
    (order.order_type === 'BUY_LIMIT' && low <= targetPrice) ||
    (order.order_type === 'SELL_LIMIT' && high >= targetPrice);

  if (executed) {
    await executeLimitOrder(env, order, now);
  } else {
    // 約定・非約定にかかわらず checked_until の更新は必須（4.4、二重判定防止）
    await db.prepare(`UPDATE orders SET checked_until = ? WHERE id = ?`).bind(to, order.id).run();
  }
}

async function executeLimitOrder(env: Env, order: OrderRow, now: number): Promise<void> {
  const db = env.DB;
  const executedPrice = order.target_price ?? 0; // 指値どおりの価格で約定（仕様書4.4）

  let rate = 1;
  if (order.market === 'US') {
    const quote = await getUsdJpyRate(env);
    if (!quote) {
      // 為替データ取得不可: 古いレートで確定させず今回は約定を見送り、次回アクセス時に再試行する
      return;
    }
    rate = quote.price;
  }

  if (order.order_type === 'BUY_LIMIT') {
    const tradeId = crypto.randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    // locked_amount_c は「指値×数量」で確保済みのため、指値どおり約定するMVPでは差額は生じない
    const stmts = [
      db
        .prepare(
          `INSERT INTO trades (id, user_id, code, symbol, name, market, quantity, locked_quantity,
             buy_date, buy_price, buy_rate, status)
           VALUES (?, ?, ?, ?, (SELECT name FROM symbols WHERE code = ? AND market = ?), ?, ?, 0, ?, ?, ?, 'HOLD')`,
        )
        .bind(tradeId, order.user_id, order.code, order.symbol, order.code, order.market, order.market, order.quantity, today, executedPrice, rate),
      db
        .prepare(
          `UPDATE orders SET status = 'EXECUTED', executed_price = ?, executed_at = ?, executed_rate = ?, checked_until = ? WHERE id = ?`,
        )
        .bind(executedPrice, now, rate, now, order.id),
    ];
    await db.batch(stmts);
    return;
  }

  // SELL_LIMIT: 注文時にlocked_lotsへ記録済みのロットのみを対象にSOLDへ変換する
  if (!order.locked_lots) {
    // 想定外だが、安全側に倒してデータ不足のまま更新はしない
    return;
  }
  const plan = (JSON.parse(order.locked_lots) as { tradeId: string; lockQty: number }[]).map((p) => ({
    tradeId: p.tradeId,
    qty: p.lockQty,
  }));

  const { results: lotRows } = await db
    .prepare(
      `SELECT id, quantity, locked_quantity, buy_date, buy_price, buy_rate FROM trades
       WHERE id IN (${plan.map(() => '?').join(',')})`,
    )
    .bind(...plan.map((p) => p.tradeId))
    .all<HoldLot>();

  const today = new Date().toISOString().slice(0, 10);
  const { stmts: sellStmts, proceedsC } = buildSellStatements(
    db,
    lotRows ?? [],
    plan,
    today,
    executedPrice,
    rate,
  );

  const currency = currencyOf(order.market);
  const column = currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';

  const stmts = [
    ...sellStmts,
    db.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE id = ?`).bind(proceedsC, order.user_id),
    db
      .prepare(
        `UPDATE orders SET status = 'EXECUTED', executed_price = ?, executed_at = ?, executed_rate = ?, checked_until = ? WHERE id = ?`,
      )
      .bind(executedPrice, now, rate, now, order.id),
  ];
  await db.batch(stmts);
}

async function expireOrder(db: D1Database, order: OrderRow): Promise<void> {
  const stmts = [db.prepare(`UPDATE orders SET status = 'EXPIRED' WHERE id = ?`).bind(order.id)];

  if (order.order_type === 'BUY_LIMIT' && order.locked_amount_c > 0) {
    // 円貨決済(settlement_currency='JPY')ならJPYで返却、それ以外は銘柄本来通貨で返却（仕様書4.9）
    const currency = settlementCurrencyOf(order.market, order.settlement_currency);
    const column = currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';
    stmts.push(
      db.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE id = ?`).bind(order.locked_amount_c, order.user_id),
    );
  } else if (order.order_type === 'SELL_LIMIT' && order.locked_lots) {
    const plan = JSON.parse(order.locked_lots) as { tradeId: string; lockQty: number }[];
    for (const { tradeId, lockQty } of plan) {
      stmts.push(
        db.prepare(`UPDATE trades SET locked_quantity = locked_quantity - ? WHERE id = ?`).bind(lockQty, tradeId),
      );
    }
  }

  await db.batch(stmts);
}
