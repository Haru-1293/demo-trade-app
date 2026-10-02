import type { Env } from '../types';
import { unixToLocalDateStr } from './timezone';
import { fetchPriceMap, fetchUsdJpy, valueHoldings, totalAssetsJpyC, type HoldLot } from './valuation';

/** 仕様書 7.4: スナップショットの日付基準はJST */
export function snapshotDateJst(nowUnix: number): string {
  return unixToLocalDateStr(nowUnix, 'Asia/Tokyo');
}

/**
 * 1ユーザー分のスナップショットUPSERT文を作る。
 * overwrite=true（Cron）: 同日の既存行を最新値で上書き
 * overwrite=false（マイページ初回表示の補完）: 同日の既存行があれば何もしない
 */
export function buildSnapshotStatement(
  db: D1Database,
  row: {
    userId: string;
    date: string;
    cashJpyC: number;
    cashUsdC: number;
    valuationJpyC: number;
    totalJpyC: number;
  },
  overwrite: boolean,
): D1PreparedStatement {
  const conflict = overwrite
    ? `ON CONFLICT(user_id, snapshot_date) DO UPDATE SET
         cash_jpy_c = excluded.cash_jpy_c,
         cash_usd_c = excluded.cash_usd_c,
         valuation_jpy_c = excluded.valuation_jpy_c,
         total_assets_jpy_c = excluded.total_assets_jpy_c,
         created_at = excluded.created_at`
    : `ON CONFLICT(user_id, snapshot_date) DO NOTHING`;
  return db
    .prepare(
      `INSERT INTO asset_snapshots
         (id, user_id, snapshot_date, cash_jpy_c, cash_usd_c, valuation_jpy_c, total_assets_jpy_c, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
    )
    .bind(
      crypto.randomUUID(),
      row.userId,
      row.date,
      row.cashJpyC,
      row.cashUsdC,
      row.valuationJpyC,
      row.totalJpyC,
      Math.floor(Date.now() / 1000),
    );
}

/** Cron用: 全ACTIVEユーザーの日次スナップショットを記録する */
export async function takeAssetSnapshots(env: Env): Promise<{ count: number; skipped?: string }> {
  const usdJpy = await fetchUsdJpy(env);
  if (usdJpy === null) {
    // 為替が取れないと円換算の総資産が出せないため、誤った値を残さず今回は見送る
    return { count: 0, skipped: 'usd/jpy rate unavailable' };
  }

  const { results: users } = await env.DB.prepare(
    `SELECT id, cash_balance_jpy_c, cash_balance_usd_c FROM users WHERE status = 'ACTIVE'`,
  ).all<{ id: string; cash_balance_jpy_c: number; cash_balance_usd_c: number }>();

  const { results: lots } = await env.DB.prepare(
    `SELECT user_id, symbol, market, quantity, buy_price, buy_rate FROM trades WHERE status = 'HOLD'`,
  ).all<HoldLot>();

  const lotsByUser = new Map<string, HoldLot[]>();
  for (const lot of lots) {
    const arr = lotsByUser.get(lot.user_id) ?? [];
    arr.push(lot);
    lotsByUser.set(lot.user_id, arr);
  }

  const priceMap = await fetchPriceMap(env, lots.map((l) => l.symbol));
  const date = snapshotDateJst(Math.floor(Date.now() / 1000));

  const stmts = users.map((u) => {
    const v = valueHoldings(lotsByUser.get(u.id) ?? [], priceMap, usdJpy);
    return buildSnapshotStatement(
      env.DB,
      {
        userId: u.id,
        date,
        cashJpyC: u.cash_balance_jpy_c,
        cashUsdC: u.cash_balance_usd_c,
        valuationJpyC: v.valuationJpyC,
        totalJpyC: totalAssetsJpyC(u.cash_balance_jpy_c, u.cash_balance_usd_c, usdJpy, v.valuationJpyC),
      },
      true,
    );
  });

  const BATCH = 50;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await env.DB.batch(stmts.slice(i, i + BATCH));
  }
  return { count: stmts.length };
}
