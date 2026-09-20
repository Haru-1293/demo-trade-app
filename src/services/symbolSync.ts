import * as XLSX from 'xlsx';
import type { Env } from '../types';

/**
 * 仕様書: 毎日08:30(JST)にCronトリガーで実行し、symbolsテーブルを更新する。
 * データソース:
 *   - 日本株: 東証が自ら公開している上場会社一覧(data_j.xlsx)。
 *     J-Quants APIは「取得データの閲覧可能な形式での配布・共有禁止」という利用規約上の懸念があり、
 *     複数人が使う可能性のある本アプリでは採用を見送った（詳細はユーザーとの合意事項）。
 *   - 米国株: SEC(米証券取引委員会)が公開する company_tickers.json。米国政府の公開データで
 *     利用制限は特にないが、SECのフェアユースポリシーに従い User-Agent を必ず明示する。
 */

interface SymbolSyncResult {
  jpCount: number;
  usCount: number;
  errors: string[];
}

// data_j.xlsx のヘッダー名（JPXが変更した場合はここを直す）
const JPX_HEADER_CODE = 'コード';
const JPX_HEADER_NAME = '銘柄名';
const JPX_HEADER_MARKET_SEGMENT = '市場・商品区分';

/** 上場会社一覧のうち、国内株式（普通株式）とみなせる市場区分か */
function isDomesticEquitySegment(segment: string): boolean {
  return segment.includes('内国株式');
}

export async function fetchJpxListedCompanies(
  env: Env,
): Promise<{ code: string; name: string }[]> {
  const res = await fetch(env.JPX_LISTED_XLSX_URL);
  if (!res.ok) throw new Error(`JPX xlsx fetch failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();

  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('JPX xlsxにシートが見つかりません');
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('JPX xlsxのシート読み込みに失敗しました');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  const firstRow = rows[0];
  if (!firstRow || !(JPX_HEADER_CODE in firstRow)) {
    throw new Error(
      `JPX xlsxの列名が想定と異なります（期待: "${JPX_HEADER_CODE}" 列）。JPX側でフォーマットが変更された可能性があります。`,
    );
  }

  const out: { code: string; name: string }[] = [];
  for (const row of rows) {
    const code = String(row[JPX_HEADER_CODE] ?? '').trim();
    const name = String(row[JPX_HEADER_NAME] ?? '').trim();
    const segment = String(row[JPX_HEADER_MARKET_SEGMENT] ?? '').trim();
    if (!code || !name) continue;
    if (!isDomesticEquitySegment(segment)) continue; // ETF・REIT・外国株等は対象外
    out.push({ code, name });
  }
  return out;
}

interface SecTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

export async function fetchSecCompanyTickers(env: Env): Promise<SecTickerEntry[]> {
  const res = await fetch(env.SEC_TICKERS_URL, {
    headers: { 'User-Agent': env.SEC_USER_AGENT },
  });
  if (!res.ok) throw new Error(`SEC company_tickers.json fetch failed: ${res.status}`);
  const json = await res.json<Record<string, SecTickerEntry>>();
  return Object.values(json);
}

/** D1のbatch呼び出しは1回あたりの文数に実務上の上限があるため、チャンク分割して順に実行する */
async function batchInChunks(db: D1Database, stmts: D1PreparedStatement[], chunkSize = 50): Promise<void> {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }
}

export async function syncSymbols(env: Env): Promise<SymbolSyncResult> {
  const errors: string[] = [];
  let jpRows: { code: string; name: string }[] = [];
  let usRows: SecTickerEntry[] = [];

  try {
    jpRows = await fetchJpxListedCompanies(env);
  } catch (e) {
    errors.push(`JPX取得失敗: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    usRows = await fetchSecCompanyTickers(env);
  } catch (e) {
    errors.push(`SEC取得失敗: ${e instanceof Error ? e.message : String(e)}`);
  }

  const jpStmts = jpRows.map((r) =>
    env.DB.prepare(
      `INSERT INTO symbols (code, market, symbol, name, currency, unit_size, active)
       VALUES (?, 'JP', ?, ?, 'JPY', 100, 1)
       ON CONFLICT(code, market) DO UPDATE SET
         symbol = excluded.symbol, name = excluded.name, active = 1`,
    ).bind(r.code, `${r.code}.T`, r.name),
  );

  const usStmts = usRows.map((r) => {
    const ticker = r.ticker.toUpperCase();
    return env.DB.prepare(
      `INSERT INTO symbols (code, market, symbol, name, currency, unit_size, active)
       VALUES (?, 'US', ?, ?, 'USD', 1, 1)
       ON CONFLICT(code, market) DO UPDATE SET
         symbol = excluded.symbol, name = excluded.name, active = 1`,
    ).bind(ticker, ticker, r.title);
  });

  try {
    await batchInChunks(env.DB, jpStmts);
  } catch (e) {
    errors.push(`JPX DB反映失敗: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await batchInChunks(env.DB, usStmts);
  } catch (e) {
    errors.push(`SEC DB反映失敗: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 配信用キャッシュ(12h)を同期のたびに無効化する。次回アクセス時にDBから再構築される。
  try {
    await env.RATE_LIMIT_KV.delete('symbols_full_cache');
  } catch {
    /* noop */
  }

  return { jpCount: jpStmts.length, usCount: usStmts.length, errors };
}
