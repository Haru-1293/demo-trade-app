export type Market = 'JP' | 'US';
export type Currency = 'JPY' | 'USD';
export type UserRole = 'USER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'FROZEN' | 'DELETED';
export type OrderType = 'BUY_MARKET' | 'SELL_MARKET' | 'BUY_LIMIT' | 'SELL_LIMIT';
export type OrderStatus =
  | 'PENDING'
  | 'EXECUTED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'DATA_UNAVAILABLE';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  RATE_LIMIT_KV: KVNamespace;
  SEND_EMAIL: SendEmailBinding;

  // vars（wrangler.json参照）
  USE_WORKER_PROXY: string;
  SESSION_COOKIE_NAME: string;
  SESSION_TTL_DAYS: string;
  LOGIN_MAX_FAILS: string;
  LOGIN_LOCKOUT_MINUTES: string;
  ORDER_EXPIRY_MAX_DAYS: string;
  MARKET_DATA_CACHE_SECONDS: string;
  SLIPPAGE_SAFETY_FACTOR: string;
  FX_EXCHANGE_RATE_LIMIT_PER_MIN: string;

  // secrets（`wrangler secret put` で設定。wrangler.jsonには書かない）
  TURNSTILE_SECRET_KEY: string;
  CSRF_SECRET: string;

  // 管理画面（独立セッション + WebAuthn）
  ADMIN_SESSION_COOKIE_NAME: string;
  ADMIN_SESSION_TTL_DAYS: string;
  WEBAUTHN_RP_NAME: string;
  WEBAUTHN_RP_ID: string;
  WEBAUTHN_ORIGIN: string;

  // 銘柄マスタの自動同期（JPX公開xlsx + SEC company_tickers.json）
  JPX_LISTED_XLSX_URL: string;
  SEC_TICKERS_URL: string;
  SEC_USER_AGENT: string;
  SYMBOL_CACHE_TTL_SECONDS: string;
}

export interface UserRow {
  id: string;
  username: string;
  email: string | null; // パスワード変更通知(4.5)の宛先。任意項目
  password_salt: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  cash_balance_jpy_c: number;
  cash_balance_usd_c: number;
  failed_login_attempts: number;
  lockout_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id_hash: string;
  user_id: string;
  expires_at: number;
  created_at: number;
}

export interface SymbolRow {
  code: string;
  market: Market;
  symbol: string;
  name: string;
  currency: Currency;
  unit_size: number;
  active: number;
}

export interface TradeRow {
  id: string;
  user_id: string;
  code: string;
  symbol: string;
  name: string;
  market: Market;
  quantity: number;
  locked_quantity: number;
  buy_date: string;
  buy_price: number;
  buy_rate: number;
  status: 'HOLD' | 'SOLD';
  sell_date: string | null;
  sell_price: number | null;
  sell_rate: number | null;
  profit_jpy_c: number | null;
}

export interface OrderRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  code: string;
  symbol: string;
  market: Market;
  order_type: OrderType;
  target_price: number | null;
  quantity: number;
  locked_amount_c: number;
  locked_lots: string | null; // SELL_LIMIT用: JSON文字列 [{trade_id, qty}]
  settlement_currency: 'NATIVE' | 'JPY'; // 米国株買いの円貨決済フラグ（4.9参照）
  ordered_at: number;
  expires_at: number | null;
  checked_until: number | null;
  status: OrderStatus;
  executed_price: number | null;
  executed_at: number | null;
  executed_rate: number | null;
}

/** リクエスト単位でセットされるコンテキスト（認証ミドルウェア通過後） */
export interface AuthContext {
  userId: string;
  role: UserRole;
  status: UserStatus;
}

/** 管理画面専用セッションのコンテキスト（通常アプリのAuthContextとは別物） */
export interface AdminAuthContext {
  userId: string;
}

export interface AdminSessionRow {
  id_hash: string;
  user_id: string;
  expires_at: number;
  created_at: number;
}

export interface WebauthnCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  label: string | null;
  created_at: number;
}

/**
 * Cloudflare Email Routing の send_email バインディング型。
 * @cloudflare/workers-types のバージョンによっては型が未提供のため、最小限を自前で宣言する。
 */
export interface SendEmailBinding {
  send(message: InstanceType<typeof import('cloudflare:email').EmailMessage>): Promise<void>;
}
