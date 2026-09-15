import { Hono } from 'hono';
import type { Env, Market, OrderType } from '../types';
import { requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { currencyOf, tryDeductCash, toAmountC } from '../services/balance';
import { getCurrentPrice, getUsdJpyRate } from '../services/marketData';

const app = new Hono<{ Bindings: Env }>();

interface MarketOrderBody {
  code: string;
  market: Market;
  side: 'BUY' | 'SELL';
  quantity: number;
  idempotency_key: string;
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

  // 二重送信防止: idempotency_keyがUNIQUE制約に引っかかれば既存注文の結果を返す
  const existing = await c.env.DB.prepare(`SELECT * FROM orders WHERE idempotency_key = ?`)
    .bind(body.idempotency_key)
    .first();
  if (existing) {
    return c.json({ order: existing });
  }

  const symbolRow = await c.env.DB.prepare(
    `SELECT * FROM symbols WHERE code = ? AND market = ? AND active = 1`,
  )
    .bind(body.code, body.market)
    .first<{ symbol: string; currency: 'JPY' | 'USD' }>();
  if (!symbolRow) return c.json({ error: 'symbol not found' }, 400);

  const quote = await getCurrentPrice(c.env, symbolRow.symbol);
  if (!quote) return c.json({ error: 'market data unavailable' }, 503);

  const rate =
    symbolRow.currency === 'USD' ? (await getUsdJpyRate(c.env))?.price ?? null : 1;
  if (rate == null) return c.json({ error: 'fx data unavailable' }, 503);

  if (body.side === 'BUY') {
    const slippage = Number(c.env.SLIPPAGE_SAFETY_FACTOR || '1.05');
    const requiredC = toAmountC(quote.price * slippage, body.quantity, rate);
    const currency = currencyOf(body.market);
    // 概算額(スリッページ込み)でチェックするが、実引き落としは実額のみ（差額返却は不要）
    const checkOk = await tryDeductCash(c.env.DB, auth.userId, currency, requiredC);
    if (!checkOk) return c.json({ error: 'insufficient funds' }, 400);

    const actualC = toAmountC(quote.price, body.quantity, rate);
    // 概算額との差額を即座に返却（成行はロック期間を持たないため即時精算）
    const refundC = requiredC - actualC;
    if (refundC > 0) {
      await c.env.DB.prepare(
        `UPDATE users SET ${currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c'} =
         ${currency === 'JPY' ? 'cash_balance_jpy_c' : 'cash_balance_usd_c'} + ? WHERE id = ?`,
      )
        .bind(refundC, auth.userId)
        .run();
    }

    // TODO: trades へ新規HOLDレコード追加、orders へEXECUTEDとして記録（batchで同一トランザクション化）
  } else {
    // TODO: 売却可能株数チェック（空売り非対応）→ trades更新 → 現金加算 → orders記録
  }

  return c.json({ error: 'not implemented' }, 501);
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
  void auth;

  if (!Number.isInteger(body.quantity) || body.quantity <= 0) {
    return c.json({ error: 'invalid quantity' }, 400);
  }

  const maxDays = Number(c.env.ORDER_EXPIRY_MAX_DAYS || '14');
  // TODO: body.expires_date と body.market から現地タイムゾーンで23:59:59のUTC秒を計算し、
  // 「注文受付時点の現地日付」からmaxDays日先までかを検証する（Intl.DateTimeFormatまたはluxon等を使用）
  void maxDays;

  // TODO: 二重送信防止(idempotency_key)、必要ロック額の計算とtryDeductCash、
  // orders(status='PENDING')への保存をトランザクション化

  return c.json({ error: 'not implemented' }, 501);
});

/** POST /api/orders/:id/cancel — 仕様書4.3 */
app.post('/orders/:id/cancel', requireCsrf, requireAuth, async (c) => {
  const auth = c.get('auth');
  const orderId = c.req.param('id');
  void auth;
  void orderId;

  // TODO: status='CANCELLED'へ更新し、locked_amount_c(またはtradesのロック株数)を即時全額解除

  return c.json({ error: 'not implemented' }, 501);
});

export default app;
