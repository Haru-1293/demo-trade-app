import type { Env } from '../types';
import { getUsdJpyRate } from './marketData';
import { requireChangesGuard, isStateChangedError } from './orderGuard';

export type FxDirection = 'JPY_TO_USD' | 'USD_TO_JPY';
export type FxResult = { status: number; body: Record<string, unknown> };

/**
 * 両替（仕様書4.6）。REST（/api/fx/exchange）とMCP（exchange_currency）の共通処理。
 * 残高の引き落とし・入金・履歴の記録を1つのbatch（トランザクション）で行い、途中で失敗しても資金が消えない。
 * 残高不足のときは先頭の更新が0行になり、requireChangesGuard で全体を巻き戻す。
 */
export async function exchangeCurrency(env: Env, userId: string, direction: unknown, amountC: unknown): Promise<FxResult> {
  if (direction !== 'JPY_TO_USD' && direction !== 'USD_TO_JPY') return { status: 400, body: { error: 'invalid direction' } };
  if (typeof amountC !== 'number' || !Number.isInteger(amountC) || amountC <= 0 || amountC > 1e13) {
    return { status: 400, body: { error: 'invalid amount' } };
  }
  const rateQuote = await getUsdJpyRate(env);
  if (!rateQuote) return { status: 503, body: { error: 'fx data unavailable' } };

  const jpyToUsd = direction === 'JPY_TO_USD';
  const from = jpyToUsd ? 'cash_balance_jpy_c' : 'cash_balance_usd_c';
  const to = jpyToUsd ? 'cash_balance_usd_c' : 'cash_balance_jpy_c';
  const resultC = jpyToUsd ? Math.floor(amountC / rateQuote.price) : Math.floor(amountC * rateQuote.price);
  if (resultC <= 0) return { status: 400, body: { error: 'amount too small' } };

  const now = Math.floor(Date.now() / 1000);
  const db = env.DB;
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(`UPDATE users SET ${from} = ${from} - ?, updated_at = ? WHERE id = ? AND ${from} >= ?`).bind(amountC, now, userId, amountC),
      requireChangesGuard(db),
      db.prepare(`UPDATE users SET ${to} = ${to} + ?, updated_at = ? WHERE id = ?`).bind(resultC, now, userId),
      db
        .prepare(
          `INSERT INTO fx_transactions (id, user_id, direction, source_amount_c, fx_rate, result_amount_c, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, userId, direction, amountC, rateQuote.price, resultC, now),
    ]);
  } catch (e) {
    if (isStateChangedError(e)) return { status: 400, body: { error: 'insufficient funds' } };
    throw e;
  }
  return { status: 200, body: { ok: true, id, result_amount_c: resultC, fx_rate: rateQuote.price } };
}
