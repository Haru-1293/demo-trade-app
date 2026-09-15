import type { Env, Currency, Market } from '../types';

/**
 * 仕様書 1./4.2/4.3: 余力チェックとロックは同一トランザクション内で行い、
 * 同時リクエストによる二重使用（TOCTOU）を防止する。
 * D1のbatch/単一SQL文（UPDATE ... WHERE 残高 >= 必要額）で検証と更新を一体化する。
 */

export function currencyOf(market: Market): Currency {
  return market === 'JP' ? 'JPY' : 'USD';
}

/**
 * 現金残高から必要額を1SQL文で検証・仮確保する。
 * 影響行数が0であれば「残高不足」として呼び出し元は却下する。
 *
 * 例（JPYの場合）:
 *   UPDATE users
 *   SET cash_balance_jpy_c = cash_balance_jpy_c - ?
 *   WHERE id = ? AND cash_balance_jpy_c >= ?
 */
export async function tryDeductCash(
  db: D1Database,
  userId: string,
  currency: Currency,
  amountC: number,
): Promise<boolean> {
  const column = currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';
  const stmt = db.prepare(
    `UPDATE users SET ${column} = ${column} - ?, updated_at = ?
     WHERE id = ? AND ${column} >= ?`,
  );
  const res = await stmt
    .bind(amountC, Math.floor(Date.now() / 1000), userId, amountC)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function creditCash(
  db: D1Database,
  userId: string,
  currency: Currency,
  amountC: number,
): Promise<void> {
  const column = currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';
  await db
    .prepare(`UPDATE users SET ${column} = ${column} + ?, updated_at = ? WHERE id = ?`)
    .bind(amountC, Math.floor(Date.now() / 1000), userId)
    .run();
}

/**
 * 通貨単位（0.01円/0.01USD）未満を切り捨てて銭/セント単位のINTEGERへ変換する。
 * price: 市場価格(REAL), quantity: 数量, rate: 為替レート(JPY以外は1)
 */
export function toAmountC(price: number, quantity: number, rate: number): number {
  const yenOrUsd = price * quantity * rate;
  return Math.floor(yenOrUsd * 100);
}

/** 保有株数のうち、既存のPending指値売りロックを除いた「売却可能株数」を返す */
export async function getSellableQuantity(
  db: D1Database,
  userId: string,
  code: string,
  market: Market,
): Promise<number> {
  // TODO: trades.status='HOLD' の合計quantityから、
  // orders(status='PENDING', order_type='SELL_LIMIT') でロック中の株数を差し引く
  throw new Error('not implemented');
}
