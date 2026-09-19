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
 * 決済通貨を決定する。円貨決済(settlement_currency='JPY')の米国株買いのみ
 * 銘柄本来の通貨(USD)ではなくJPYで拘束・決済する（仕様書4.9）。
 * それ以外は currencyOf(market) と同じ（従来通り）。
 */
export function settlementCurrencyOf(
  market: Market,
  settlementCurrency?: 'NATIVE' | 'JPY',
): Currency {
  if (settlementCurrency === 'JPY') return 'JPY';
  return currencyOf(market);
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
 * price: 市場価格(REAL、銘柄本来の通貨建て), quantity: 数量
 * rate: 通貨換算レート。
 *   - 決済通貨が銘柄本来の通貨と同じ場合（外貨決済・日本株）は常に rate=1 を渡すこと。
 *     rateに為替レートを渡すと「別通貨に換算した額」になってしまい、
 *     銘柄本来通貨の残高（USD残高など）への入出金額としては誤りになる。
 *   - 為替レートを渡すのは、円貨決済（4.9）や profit_jpy_c の円換算計算など、
 *     明示的に「別通貨に換算した金額」が必要な場合のみ。
 */
export function toAmountC(price: number, quantity: number, rate: number): number {
  const yenOrUsd = price * quantity * rate;
  return Math.floor(yenOrUsd * 100);
}

/** 保有株数のうち、既存のPending指値売りロック(trades.locked_quantity)を除いた「売却可能株数」を返す */
export async function getSellableQuantity(
  db: D1Database,
  userId: string,
  code: string,
  market: Market,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(quantity - locked_quantity), 0) AS sellable
       FROM trades
       WHERE user_id = ? AND code = ? AND market = ? AND status = 'HOLD'`,
    )
    .bind(userId, code, market)
    .first<{ sellable: number }>();
  return row?.sellable ?? 0;
}

/**
 * SELL_LIMIT注文受付時: 保有中(HOLD)ロットをFIFO(buy_date昇順)でquantity分ロックする。
 * 全量ロックできればロットごとの内訳（trade_id, locked_qty）を返し、できなければnullを返す
 * （呼び出し元は注文全体を却下する。全量ロック or 不成立で部分約定は行わない）。
 */
export async function lockSellableQuantity(
  db: D1Database,
  userId: string,
  code: string,
  market: Market,
  quantity: number,
): Promise<{ tradeId: string; lockQty: number }[] | null> {
  const { results } = await db
    .prepare(
      `SELECT id, quantity, locked_quantity FROM trades
       WHERE user_id = ? AND code = ? AND market = ? AND status = 'HOLD'
         AND quantity > locked_quantity
       ORDER BY buy_date ASC`,
    )
    .bind(userId, code, market)
    .all<{ id: string; quantity: number; locked_quantity: number }>();

  let remaining = quantity;
  const plan: { tradeId: string; lockQty: number }[] = [];
  for (const row of results ?? []) {
    if (remaining <= 0) break;
    const available = row.quantity - row.locked_quantity;
    const take = Math.min(available, remaining);
    plan.push({ tradeId: row.id, lockQty: take });
    remaining -= take;
  }
  if (remaining > 0) return null; // 全量確保できなかった

  const stmts = plan.map(({ tradeId, lockQty }) =>
    db
      .prepare(`UPDATE trades SET locked_quantity = locked_quantity + ? WHERE id = ?`)
      .bind(lockQty, tradeId),
  );
  await db.batch(stmts);
  return plan;
}

/** キャンセル・期限切れ時: ロックしていた株数を解除する */
export async function unlockQuantity(
  db: D1Database,
  tradeId: string,
  qty: number,
): Promise<void> {
  await db
    .prepare(`UPDATE trades SET locked_quantity = locked_quantity - ? WHERE id = ?`)
    .bind(qty, tradeId)
    .run();
}

/**
 * 成行売り用: ロック中(locked_quantity)を除いた売却可能株数からFIFOで消費プランを組む。
 * 併せて対象ロットの詳細（原価計算用）も返す。全量確保できなければnull。
 */
export async function selectFifoLotsForSale(
  db: D1Database,
  userId: string,
  code: string,
  market: Market,
  quantity: number,
): Promise<{ lots: HoldLot[]; plan: { tradeId: string; qty: number }[] } | null> {
  const { results } = await db
    .prepare(
      `SELECT id, quantity, locked_quantity, buy_date, buy_price, buy_rate FROM trades
       WHERE user_id = ? AND code = ? AND market = ? AND status = 'HOLD'
         AND quantity > locked_quantity
       ORDER BY buy_date ASC`,
    )
    .bind(userId, code, market)
    .all<HoldLot>();

  const lots = results ?? [];
  let remaining = quantity;
  const plan: { tradeId: string; qty: number }[] = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const available = lot.quantity - lot.locked_quantity;
    const take = Math.min(available, remaining);
    if (take > 0) plan.push({ tradeId: lot.id, qty: take });
    remaining -= take;
  }
  if (remaining > 0) return null;
  return { lots, plan };
}

export interface HoldLot {
  id: string;
  quantity: number;
  locked_quantity: number;
  buy_date: string;
  buy_price: number;
  buy_rate: number;
}

/**
 * 指定ロット群（FIFOで選定済み、または明示指定）をSOLDへ変換するSQL文を組み立てる。
 * ロットのquantityと消費数が一致すれば当該行をSOLDへ更新、
 * 一致しなければ「残数量を引いたHOLD行」+「消費分の新規SOLD行」に分割する。
 * 部分約定ではなく、あくまで1回の売却注文の全量分をロット単位で内部処理する。
 *
 * 重要: 口座に実際にクレジットする金額(proceedsC)は必ず銘柄本来通貨での実額（rate=1）。
 * 為替レート(sellRate/buy_rate)は profit_jpy_c（円換算損益、レポーティング用）の
 * 算出にのみ用いる。両者を混同すると残高が為替レート倍/分の1になる誤りが生じる。
 */
export function buildSellStatements(
  db: D1Database,
  lots: HoldLot[],
  plan: { tradeId: string; qty: number }[],
  sellDate: string,
  sellPrice: number,
  sellRate: number,
): { stmts: D1PreparedStatement[]; totalProfitC: number; proceedsC: number } {
  const stmts: D1PreparedStatement[] = [];
  let totalProfitC = 0;
  let proceedsC = 0; // 銘柄本来通貨での実額（口座へクレジットする額）

  const lotById = new Map(lots.map((l) => [l.id, l]));

  for (const { tradeId, qty } of plan) {
    const lot = lotById.get(tradeId);
    if (!lot) continue;

    const nativeProceedsC = toAmountC(sellPrice, qty, 1); // 実際に口座へ入る額（外貨のまま）
    const jpyProceedsC = toAmountC(sellPrice, qty, sellRate); // 円換算（損益計算用）
    const jpyCostC = toAmountC(lot.buy_price, qty, lot.buy_rate); // 円換算（損益計算用）
    const profitC = jpyProceedsC - jpyCostC;
    totalProfitC += profitC;
    proceedsC += nativeProceedsC;

    if (qty === lot.quantity) {
      // 全量売却: この行をそのままSOLDへ
      stmts.push(
        db
          .prepare(
            `UPDATE trades SET status = 'SOLD', sell_date = ?, sell_price = ?, sell_rate = ?,
               profit_jpy_c = ?, locked_quantity = locked_quantity - ?
             WHERE id = ?`,
          )
          .bind(sellDate, sellPrice, sellRate, profitC, qty, tradeId),
      );
    } else {
      // 部分売却: 元の行を残数量に縮小し、消費分を新規SOLD行として追加
      stmts.push(
        db
          .prepare(
            `UPDATE trades SET quantity = quantity - ?, locked_quantity = locked_quantity - ?
             WHERE id = ?`,
          )
          .bind(qty, qty, tradeId),
      );
      stmts.push(
        db
          .prepare(
            `INSERT INTO trades
               (id, user_id, code, symbol, name, market, quantity, locked_quantity,
                buy_date, buy_price, buy_rate, status, sell_date, sell_price, sell_rate, profit_jpy_c)
             SELECT ?, user_id, code, symbol, name, market, ?, 0,
                buy_date, buy_price, buy_rate, 'SOLD', ?, ?, ?, ?
             FROM trades WHERE id = ?`,
          )
          .bind(crypto.randomUUID(), qty, sellDate, sellPrice, sellRate, profitC, tradeId),
      );
    }
  }

  return { stmts, totalProfitC, proceedsC };
}
