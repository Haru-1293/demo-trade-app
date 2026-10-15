import type { Env, OrderRow } from '../types';
import type { Scope } from '../services/oauth';
import { checkPendingLimitOrders } from '../services/limitCheck';
import { fetchPricesAndRate, valueHoldings, totalAssetsJpyC, type HoldLot } from '../services/valuation';
import { getDisplayPrices } from '../services/marketData';
import { settlementCurrencyOf } from '../services/balance';
import { placeMarketOrder, placeLimitOrder, cancelOrder } from '../services/orderService';

/**
 * MCPのツール定義（仕様書4.18）。各ツールは必要なスコープを持ち、tools/list は付与された範囲だけを返す。
 * 失敗はToolErrorで投げ、プロトコルエラーではなく isError のツール結果として返す（AIが直して再試行できるように）。
 */
export class ToolError extends Error {}

export interface ToolCtx {
  env: Env;
  userId: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  run(ctx: ToolCtx, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const SYMBOL_PATTERN = /^[A-Za-z0-9.\-=^]{1,20}$/;
const ORDER_STATUSES = ['PENDING', 'EXECUTED', 'EXPIRED', 'CANCELLED', 'REJECTED', 'DATA_UNAVAILABLE'];

const iso = (sec: number | null | undefined): string | null => (sec == null ? null : new Date(sec * 1000).toISOString());
const money = (c: number): number => Math.round(c) / 100; // 銭・セント → 円・ドル

function optString(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new ToolError(`${key} must be a string of at most ${max} characters`);
  return v;
}
function reqString(args: Record<string, unknown>, key: string, max: number): string {
  const v = optString(args, key, max);
  if (!v) throw new ToolError(`${key} is required`);
  return v;
}
function optLimit(args: Record<string, unknown>, def: number, max: number): number {
  const v = args.limit;
  if (v === undefined || v === null) return def;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new ToolError(`limit must be an integer from 1 to ${max}`);
  return v as number;
}
function optEnum(args: Record<string, unknown>, key: string, allowed: string[]): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new ToolError(`${key} must be one of: ${allowed.join(', ')}`);
  return v;
}

const nativeCurrency = (market: string) => (market === 'JP' ? 'JPY' : 'USD');

async function settleLimitOrders(env: Env, userId: string): Promise<void> {
  // /api/portfolio・/api/orders と同じく、閲覧のたびに指値の遡及判定を先に行う（4.4）。失敗しても閲覧は続ける
  try {
    await checkPendingLimitOrders(env, userId);
  } catch (e) {
    console.error('limit check failed', e);
  }
}

/** 注文の頻度制限。直近60秒の注文数をD1で数えるので厳密（AIの暴走・ループの防止） */
async function assertOrderRate(env: Env, userId: string): Promise<void> {
  const limit = Math.max(1, Number(env.MCP_ORDER_RATE_LIMIT_PER_MIN || '10') || 10);
  const since = Math.floor(Date.now() / 1000) - 60;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND ordered_at >= ?`)
    .bind(userId, since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) {
    throw new ToolError(`注文が多すぎます（直近60秒で${limit}件まで）。しばらく待ってからやり直してください。 / Too many orders; wait a minute.`);
  }
}

function orderOutcome(r: { status: number; body: Record<string, unknown> }): Record<string, unknown> {
  if (r.status >= 400) throw new ToolError(String(r.body.error ?? `error ${r.status}`));
  return r.body;
}

function orderView(o: OrderRow) {
  return {
    id: o.id,
    code: o.code,
    symbol: o.symbol,
    market: o.market,
    order_type: o.order_type,
    target_price: o.target_price,
    quantity: o.quantity,
    status: o.status,
    ordered_at: iso(o.ordered_at),
    expires_at: iso(o.expires_at),
    executed_price: o.executed_price,
    executed_at: iso(o.executed_at),
  };
}

const marketEnum = { type: 'string', enum: ['JP', 'US'], description: 'JP=日本株, US=米国株' };

export const TOOLS: ToolDef[] = [
  {
    name: 'get_account_summary',
    title: '資産サマリー',
    description:
      'デモ口座の現金（円・ドル）、総資産（円換算）、保有株の評価額・取得原価・評価損益、USD/JPYを返す。' +
      '指値注文でロック中の買い付け資金は現金に含まれず、locked_in_pending_buy_orders に別掲する。',
    scope: 'portfolio:read',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ env, userId }) {
      const user = await env.DB.prepare(`SELECT cash_balance_jpy_c, cash_balance_usd_c FROM users WHERE id = ?`)
        .bind(userId)
        .first<{ cash_balance_jpy_c: number; cash_balance_usd_c: number }>();
      if (!user) throw new ToolError('account not found');
      const { results: lots } = await env.DB.prepare(
        `SELECT user_id, symbol, market, quantity, buy_price, buy_rate FROM trades WHERE user_id = ? AND status = 'HOLD'`,
      ).bind(userId).all<HoldLot>();
      const { priceMap, usdJpy, usdJpyAsOf } = await fetchPricesAndRate(env, lots.map((l) => l.symbol));
      const v = valueHoldings(lots, priceMap, usdJpy);
      const total = usdJpy === null ? null : totalAssetsJpyC(user.cash_balance_jpy_c, user.cash_balance_usd_c, usdJpy, v.valuationJpyC);

      const { results: pending } = await env.DB.prepare(
        `SELECT market, settlement_currency, locked_amount_c FROM orders WHERE user_id = ? AND status = 'PENDING' AND order_type = 'BUY_LIMIT'`,
      ).bind(userId).all<{ market: 'JP' | 'US'; settlement_currency: 'NATIVE' | 'JPY'; locked_amount_c: number }>();
      let lockedJpy = 0;
      let lockedUsd = 0;
      for (const o of pending) {
        if (settlementCurrencyOf(o.market, o.settlement_currency) === 'JPY') lockedJpy += o.locked_amount_c;
        else lockedUsd += o.locked_amount_c;
      }

      return {
        cash: { jpy: money(user.cash_balance_jpy_c), usd: money(user.cash_balance_usd_c) },
        locked_in_pending_buy_orders: { jpy: money(lockedJpy), usd: money(lockedUsd) },
        usd_jpy: usdJpy,
        usd_jpy_as_of: iso(usdJpyAsOf),
        holdings_valuation_jpy: money(v.valuationJpyC),
        holdings_cost_jpy: money(v.costJpyC),
        unrealized_pnl_jpy: money(v.unrealizedJpyC),
        total_assets_jpy: total === null ? null : money(total),
        prices_are_estimated: v.stale,
      };
    },
  },
  {
    name: 'get_holdings',
    title: '保有銘柄',
    description:
      '保有中の銘柄ごとの株数、売却可能株数（指値売りでロック中の分を除く）、平均取得単価、現在値、評価額、評価損益（銘柄の通貨建て）を返す。' +
      '先に未約定の指値注文の約定判定を行う。',
    scope: 'portfolio:read',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ env, userId }) {
      await settleLimitOrders(env, userId);
      const { results } = await env.DB.prepare(
        `SELECT code, symbol, name, market, SUM(quantity) AS quantity, SUM(locked_quantity) AS locked,
                SUM(buy_price * quantity) AS cost
           FROM trades WHERE user_id = ? AND status = 'HOLD' GROUP BY code, symbol, name, market ORDER BY market, code`,
      ).bind(userId).all<{ code: string; symbol: string; name: string; market: 'JP' | 'US'; quantity: number; locked: number; cost: number }>();
      const prices = await getDisplayPrices(env, results.map((r) => r.symbol));
      return {
        holdings: results.map((r) => {
          const dp = prices.get(r.symbol);
          const avg = r.quantity > 0 ? r.cost / r.quantity : 0;
          return {
            code: r.code,
            symbol: r.symbol,
            name: r.name,
            market: r.market,
            currency: nativeCurrency(r.market),
            quantity: r.quantity,
            sellable_quantity: r.quantity - r.locked,
            average_buy_price: Math.round(avg * 10000) / 10000,
            current_price: dp ? dp.price : null,
            price_as_of: dp ? iso(dp.asOf) : null,
            market_value: dp ? Math.round(dp.price * r.quantity * 100) / 100 : null,
            unrealized_pnl: dp ? Math.round((dp.price * r.quantity - r.cost) * 100) / 100 : null,
          };
        }),
      };
    },
  },
  {
    name: 'get_orders',
    title: '注文履歴',
    description: '注文履歴（新しい順）。status で絞り込める。先に未約定の指値注文の約定判定を行う。',
    scope: 'portfolio:read',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ORDER_STATUSES, description: '指定した状態の注文だけ返す' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '最大件数（既定30）' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ env, userId }, args) {
      const status = optEnum(args, 'status', ORDER_STATUSES);
      const limit = optLimit(args, 30, 100);
      await settleLimitOrders(env, userId);
      const { results } = status
        ? await env.DB.prepare(`SELECT * FROM orders WHERE user_id = ? AND status = ? ORDER BY ordered_at DESC LIMIT ?`).bind(userId, status, limit).all<OrderRow>()
        : await env.DB.prepare(`SELECT * FROM orders WHERE user_id = ? ORDER BY ordered_at DESC LIMIT ?`).bind(userId, limit).all<OrderRow>();
      return { orders: results.map(orderView) };
    },
  },
  {
    name: 'get_trades',
    title: '取引履歴',
    description: '取引（ロット）の履歴。保有中(HOLD)と売却済み(SOLD)。売却済みは売却価格と確定損益（円換算）を含む。',
    scope: 'portfolio:read',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['HOLD', 'SOLD'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '最大件数（既定30）' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run({ env, userId }, args) {
      const status = optEnum(args, 'status', ['HOLD', 'SOLD']);
      const limit = optLimit(args, 30, 100);
      const sql = `SELECT code, symbol, name, market, quantity, buy_date, buy_price, status, sell_date, sell_price, profit_jpy_c
                     FROM trades WHERE user_id = ?${status ? ' AND status = ?' : ''} ORDER BY buy_date DESC LIMIT ?`;
      const stmt = status ? env.DB.prepare(sql).bind(userId, status, limit) : env.DB.prepare(sql).bind(userId, limit);
      const { results } = await stmt.all<{
        code: string; symbol: string; name: string; market: string; quantity: number; buy_date: string;
        buy_price: number; status: string; sell_date: string | null; sell_price: number | null; profit_jpy_c: number | null;
      }>();
      return {
        trades: results.map((t) => ({
          code: t.code, symbol: t.symbol, name: t.name, market: t.market, quantity: t.quantity,
          buy_date: t.buy_date, buy_price: t.buy_price, status: t.status,
          sell_date: t.sell_date, sell_price: t.sell_price,
          profit_jpy: t.profit_jpy_c == null ? null : money(t.profit_jpy_c),
        })),
      };
    },
  },
  {
    name: 'search_symbols',
    title: '銘柄検索',
    description:
      '銘柄をコード・名前・シンボルで検索する（最大30件）。注文には code と market を使い、現在値の取得には symbol を使う。' +
      'unit_size は売買単位（日本株は通常100株）。',
    scope: 'market:read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 50, description: '例: トヨタ / 7203 / AAPL' },
        market: marketEnum,
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run({ env }, args) {
      const q = reqString(args, 'query', 50);
      const market = optEnum(args, 'market', ['JP', 'US']);
      const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const sql = `SELECT code, market, symbol, name, currency, unit_size FROM symbols
                    WHERE active = 1 AND (code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR symbol LIKE ? ESCAPE '\\')
                    ${market ? 'AND market = ?' : ''} ORDER BY market, code LIMIT 30`;
      const stmt = market ? env.DB.prepare(sql).bind(like, like, like, market) : env.DB.prepare(sql).bind(like, like, like);
      const { results } = await stmt.all();
      return { symbols: results };
    },
  },
  {
    name: 'get_prices',
    title: '現在値',
    description:
      '表示用の現在値（最大30銘柄、数分〜30分遅れの場合がある）。symbol は search_symbols が返す値（例: 7203.T, AAPL, 為替は JPY=X）。' +
      '約定価格とは別物で、注文は発注時にサーバーが取得した価格で約定する。',
    scope: 'market:read',
    inputSchema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 } },
      required: ['symbols'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ env }, args) {
      const raw = args.symbols;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30 || raw.some((s) => typeof s !== 'string')) {
        throw new ToolError('symbols must be an array of 1 to 30 strings');
      }
      const symbols = [...new Set(raw as string[])];
      if (symbols.some((s) => !SYMBOL_PATTERN.test(s))) throw new ToolError('invalid symbol format');
      const map = await getDisplayPrices(env, symbols);
      const prices: Record<string, { price: number; as_of: string | null }> = {};
      for (const [s, dp] of map) prices[s] = { price: dp.price, as_of: iso(dp.asOf) };
      return { prices, unavailable: symbols.filter((s) => !map.has(s)) };
    },
  },
  {
    name: 'place_market_order',
    title: '成行注文',
    description:
      '成行注文を出す。サーバーが取得した現在値で全量約定するか、残高・株数不足なら却下される（部分約定・空売りなし）。' +
      'デモ資金が動く。idempotency_key を付けて再送すれば二重発注にならない。',
    scope: 'trade:write',
    inputSchema: {
      type: 'object',
      properties: {
        market: marketEnum,
        code: { type: 'string', maxLength: 20, description: 'search_symbols が返す code' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        quantity: { type: 'integer', minimum: 1, description: '株数（日本株は unit_size の倍数にすること）' },
        settlement_currency: { type: 'string', enum: ['NATIVE', 'JPY'], description: '米国株の買いのみ。JPY=円貨決済。省略時はドル決済' },
        idempotency_key: { type: 'string', maxLength: 100, description: '再送時は同じ値を渡す。省略時はサーバーが生成' },
      },
      required: ['market', 'code', 'side', 'quantity'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run({ env, userId }, args) {
      await assertOrderRate(env, userId);
      const r = await placeMarketOrder(env, userId, {
        market: args.market,
        code: args.code,
        side: args.side,
        quantity: args.quantity,
        settlement_currency: args.settlement_currency,
        idempotency_key: optString(args, 'idempotency_key', 100) ?? `mcp-${crypto.randomUUID()}`,
      });
      return orderOutcome(r);
    },
  },
  {
    name: 'place_limit_order',
    title: '指値注文',
    description:
      '指値注文を出す。買いは指値×数量の資金、売りは売却株数をロックし、以降の閲覧・アクセスのたびに過去の値幅で約定判定される。' +
      '有効期限は取引所の現地日付で、当日から14日先まで。デモ資金が動く。',
    scope: 'trade:write',
    inputSchema: {
      type: 'object',
      properties: {
        market: marketEnum,
        code: { type: 'string', maxLength: 20 },
        order_type: { type: 'string', enum: ['BUY_LIMIT', 'SELL_LIMIT'] },
        quantity: { type: 'integer', minimum: 1 },
        target_price: { type: 'number', exclusiveMinimum: 0, description: '指値（銘柄の通貨建て）' },
        expires_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD（取引所の現地日付）' },
        settlement_currency: { type: 'string', enum: ['NATIVE', 'JPY'], description: '米国株の買いのみ' },
        idempotency_key: { type: 'string', maxLength: 100 },
      },
      required: ['market', 'code', 'order_type', 'quantity', 'target_price', 'expires_date'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run({ env, userId }, args) {
      await assertOrderRate(env, userId);
      const r = await placeLimitOrder(env, userId, {
        market: args.market,
        code: args.code,
        order_type: args.order_type,
        quantity: args.quantity,
        target_price: args.target_price,
        expires_date: args.expires_date,
        settlement_currency: args.settlement_currency,
        side: args.order_type === 'SELL_LIMIT' ? 'SELL' : 'BUY',
        idempotency_key: optString(args, 'idempotency_key', 100) ?? `mcp-${crypto.randomUUID()}`,
      });
      return orderOutcome(r);
    },
  },
  {
    name: 'cancel_order',
    title: '注文の取消',
    description: '未約定(PENDING)の指値注文を取り消し、ロックした資金・株数を戻す。',
    scope: 'trade:write',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string', maxLength: 100 } },
      required: ['order_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run({ env, userId }, args) {
      return orderOutcome(await cancelOrder(env, userId, reqString(args, 'order_id', 100)));
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
