import type { Env, OrderRow } from '../types';
import { getOhlcHistory } from './marketData';
import { creditCash, currencyOf } from './balance';

/**
 * 仕様書 4.4: ユーザーのアクセス（ログイン/portfolio/orders取得）をトリガーに、
 * PENDING状態の指値注文をバックグラウンドで約定判定する。
 */
export async function checkPendingLimitOrders(
  db: D1Database,
  userId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await db
    .prepare(
      `SELECT * FROM orders WHERE user_id = ? AND status = 'PENDING'`,
    )
    .bind(userId)
    .all<OrderRow>();

  for (const order of results ?? []) {
    await checkOneOrder(db, order, now);
  }
}

async function checkOneOrder(db: D1Database, order: OrderRow, now: number): Promise<void> {
  // 期限切れ判定を先に行う
  if (order.expires_at != null && now >= order.expires_at) {
    await expireOrder(db, order);
    return;
  }

  const from = order.checked_until ?? order.ordered_at;
  const to = Math.min(now, order.expires_at ?? now);
  if (from >= to) return;

  const ohlc = await getOhlcHistory(order.symbol, from, to);

  // checked_until の更新は約定・非約定にかかわらず必須（4.4）
  if (!ohlc) {
    // データ取得不可: checked_untilは更新しない（次回再取得を試みる）
    return;
  }

  const low = Math.min(...ohlc.map((p) => p.low));
  const high = Math.max(...ohlc.map((p) => p.high));
  const targetPrice = order.target_price ?? 0;

  const executed =
    (order.order_type === 'BUY_LIMIT' && low <= targetPrice) ||
    (order.order_type === 'SELL_LIMIT' && high >= targetPrice);

  if (executed) {
    await executeLimitOrder(db, order, now);
  } else {
    await db
      .prepare(`UPDATE orders SET checked_until = ? WHERE id = ?`)
      .bind(to, order.id)
      .run();
  }
}

async function executeLimitOrder(db: D1Database, order: OrderRow, now: number): Promise<void> {
  // TODO: 同一トランザクション（batch）内で以下を実施
  //  - orders.status = 'EXECUTED', executed_price = target_price, executed_at = now, checked_until = now
  //  - BUY_LIMIT: trades に新規HOLDレコードを追加（locked_amount_cは指値どおりのため差額返却なし）
  //  - SELL_LIMIT: 対象tradesをSOLDに更新し、現金をcreditCashで加算、profit_jpy_cを計算
  throw new Error('not implemented');
}

async function expireOrder(db: D1Database, order: OrderRow): Promise<void> {
  // ロックしていた資金・株数を即時全額解除してEXPIREDへ
  if (order.order_type === 'BUY_LIMIT' && order.locked_amount_c > 0) {
    await creditCash(db, order.user_id, currencyOf(order.market), order.locked_amount_c);
  }
  // SELL_LIMITの場合はtrades側のロックフラグ解除（別途実装）
  await db
    .prepare(`UPDATE orders SET status = 'EXPIRED' WHERE id = ?`)
    .bind(order.id)
    .run();
}
