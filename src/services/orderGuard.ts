import type { OrderRow } from '../types';

/**
 * 未約定注文の状態確認（D1のbatchの先頭に置く）。
 *
 * 約定判定・期限切れ・取消・修正は、それぞれ先に読んだ注文の内容をもとに複数の文を組み立てて batch で実行する。
 * その間に別の処理が注文を変えていると、資金・株数の二重返却や、古い内容での約定が起きうる。
 * そこで batch の先頭にこの文を置き、「注文がまだPENDINGで、読んだときと同じ内容」でなければ
 * 整数オーバーフローのエラーで文を失敗させ、batch 全体を巻き戻す（D1のbatchは1つのトランザクション）。
 * 呼び出し側は isStateChangedError() で、このエラーだけを「状態が変わっていた」として扱う。
 */
const OVERFLOW = 'abs(-9223372036854775808)';

export function orderStateGuard(db: D1Database, o: OrderRow): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM orders
          WHERE id = ? AND status = 'PENDING' AND quantity = ? AND target_price IS ?
            AND locked_amount_c = ? AND expires_at IS ? AND COALESCE(locked_lots, '') = ?
       ) THEN 1 ELSE ${OVERFLOW} END`,
    )
    .bind(o.id, o.quantity, o.target_price, o.locked_amount_c, o.expires_at, o.locked_lots ?? '');
}

/** 直前の文が行を変更しなかった（changes() = 0）ときに batch を失敗させる。残高不足などの検出に使う */
export function requireChangesGuard(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN changes() > 0 THEN 1 ELSE ${OVERFLOW} END`);
}

/** 株数のロック余力（売却可能株数）が足りないとき batch を失敗させる */
export function sellableCapacityGuard(db: D1Database, tradeId: string, needQty: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN COALESCE((SELECT quantity - locked_quantity FROM trades WHERE id = ? AND status = 'HOLD'), 0) >= ?
         THEN 1 ELSE ${OVERFLOW} END`,
    )
    .bind(tradeId, needQty);
}

export function isStateChangedError(e: unknown): boolean {
  return e instanceof Error && /integer overflow/i.test(`${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ''}`);
}
