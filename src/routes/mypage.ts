import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/auth';
import { fetchPricesAndRate, valueHoldings, totalAssetsJpyC, type HoldLot } from '../services/valuation';
import { buildSnapshotStatement, snapshotDateJst } from '../services/snapshot';

const app = new Hono<{ Bindings: Env }>();

const HISTORY_DAYS = 180;

/**
 * GET /api/mypage — 仕様書 7.4
 * 現在の総資産・評価損益は、スナップショットではなくその場の現在値（60秒キャッシュ）で計算する。
 * 推移グラフ用に asset_snapshots の直近分を返す。
 */
app.get('/mypage', requireAuth, async (c) => {
  const auth = c.get('auth');

  const user = await c.env.DB.prepare(
    `SELECT cash_balance_jpy_c, cash_balance_usd_c FROM users WHERE id = ?`,
  )
    .bind(auth.userId)
    .first<{ cash_balance_jpy_c: number; cash_balance_usd_c: number }>();
  if (!user) return c.json({ error: 'not found' }, 404);

  const { results: lots } = await c.env.DB.prepare(
    `SELECT user_id, symbol, market, quantity, buy_price, buy_rate
     FROM trades WHERE user_id = ? AND status = 'HOLD'`,
  )
    .bind(auth.userId)
    .all<HoldLot>();

  const { priceMap, usdJpy, usdJpyAsOf } = await fetchPricesAndRate(c.env, lots.map((l) => l.symbol));
  const v = valueHoldings(lots, priceMap, usdJpy);
  const total =
    usdJpy === null ? null : totalAssetsJpyC(user.cash_balance_jpy_c, user.cash_balance_usd_c, usdJpy, v.valuationJpyC);

  // 新規ユーザー・機能追加直後でもグラフが空にならないよう、当日分が無ければ補完する（Cronの値は上書きしない）
  if (total !== null) {
    const date = snapshotDateJst(Math.floor(Date.now() / 1000));
    await buildSnapshotStatement(
      c.env.DB,
      {
        userId: auth.userId,
        date,
        cashJpyC: user.cash_balance_jpy_c,
        cashUsdC: user.cash_balance_usd_c,
        valuationJpyC: v.valuationJpyC,
        totalJpyC: total,
      },
      false,
    ).run();
  }

  const { results: snaps } = await c.env.DB.prepare(
    `SELECT snapshot_date, cash_jpy_c, cash_usd_c, valuation_jpy_c, total_assets_jpy_c
     FROM asset_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT ?`,
  )
    .bind(auth.userId, HISTORY_DAYS)
    .all();

  return c.json({
    cash_jpy_c: user.cash_balance_jpy_c,
    cash_usd_c: user.cash_balance_usd_c,
    usd_jpy: usdJpy,
    usd_jpy_as_of: usdJpyAsOf,
    // 銘柄ごとの内訳。クライアントはWSSで受信済みのライブ価格があれば、これを使って評価額を再計算する
    holdings: v.bySymbol.map((h) => ({
      symbol: h.symbol,
      market: h.market,
      quantity: h.quantity,
      cost_jpy_c: h.costJpyC,
      valuation_jpy_c: h.valuationJpyC,
      price: h.price,
      as_of: h.asOf,
    })),
    valuation_jpy_c: v.valuationJpyC,
    cost_jpy_c: v.costJpyC,
    unrealized_pnl_jpy_c: v.unrealizedJpyC,
    total_assets_jpy_c: total,
    stale: v.stale,
    snapshots: snaps.reverse(),
  });
});

export default app;
