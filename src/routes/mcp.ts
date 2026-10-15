import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { SCOPES, issuerOf, resourceOf, verifyAccessToken, memoryRateLimit } from '../services/oauth';
import { TOOLS, TOOLS_BY_NAME, ToolError } from '../mcp/tools';

/**
 * リモートMCPサーバー（仕様書4.18）。Streamable HTTPの単一エンドポイント `POST /mcp`。
 * ベアラートークン（OAuth、4.17）のみを受け付け、Cookieは見ない。応答は常に単一のJSON。
 *
 * 新しい2026-07-28（リクエスト単位のステートレス方式）と、従来の initialize 方式
 * （2025-11-25 / 2025-06-18 / 2025-03-26）の両方に答える。
 */
const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const ALL_VERSIONS = [MODERN, ...LEGACY];
const SERVER_INFO = { name: 'demo-trade-app', version: '0.3.0' };
const INSTRUCTIONS =
  'This server operates a virtual-money (demo) trading account for Japanese and US stocks, for learning and simulation only. ' +
  '日米株のデモトレード口座（仮想資金・学習用）を操作します。' +
  'Use search_symbols to find a stock (code, market, symbol, unit_size), then place orders with that code and market. ' +
  'Japanese stocks usually trade in units of 100 shares. Order tools move demo money; confirm intent with the user before placing orders.';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

const app = new Hono<{ Bindings: Env }>();

type JsonRpcId = string | number | null;

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function allowedOrigins(c: Context<{ Bindings: Env }>): string[] {
  const extra = (c.env.MCP_ALLOWED_ORIGINS ?? 'https://claude.ai,https://claude.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [new URL(c.req.url).origin, ...extra];
}

/** 許可したOriginにだけCORSヘッダーを返す（クレデンシャルは許可しない） */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** Mcp-Name のBase64記法（=?base64?…?=）を復号する。不正ならnull */
function decodeHeaderValue(v: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(v);
  if (!m) return v;
  try {
    const bin = atob(m[1]!);
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

app.all('/mcp', async (c) => {
  const origin = c.req.header('Origin');
  const cors = corsHeaders(origin);

  // DNSリバインディング対策: Originがあるなら自サイトか許可リストのものだけ（無い＝ブラウザ以外は許可）
  if (origin && !allowedOrigins(c).includes(origin)) {
    return c.json(rpcError(null, -32600, 'Origin not allowed'), 403);
  }
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (c.req.method !== 'POST') {
    // GETのSSEストリームとDELETEによるセッション終了は提供しない
    return c.json(rpcError(null, -32600, 'Method not allowed'), 405, { ...cors, Allow: 'POST, OPTIONS' });
  }

  const issuer = issuerOf(c.req.url);
  const resource = resourceOf(issuer);
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;

  // ---------- 認証 ----------
  const authz = c.req.header('Authorization') ?? '';
  const bearer = /^Bearer\s+(\S+)$/i.exec(authz)?.[1];
  const auth = bearer ? await verifyAccessToken(c.env, bearer, resource, c.executionCtx) : null;
  if (!auth) {
    const invalid = bearer ? ', error="invalid_token"' : '';
    return c.json(rpcError(null, -32001, 'Unauthorized'), 401, {
      ...cors,
      'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", scope="${SCOPES.join(' ')}"${invalid}`,
    });
  }
  if (!memoryRateLimit(`mcp:${auth.grantId}`, 60, 60_000)) {
    return c.json(rpcError(null, 4290, 'Too many requests'), 429, { ...cors, 'Retry-After': '30' });
  }

  // ---------- 本文 ----------
  const text = await c.req.text();
  if (text.length > 64 * 1024) return c.json(rpcError(null, -32600, 'Request too large'), 413, cors);
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error'), 400, cors);
  }
  if (Array.isArray(msg)) return c.json(rpcError(null, -32600, 'Batch requests are not supported'), 400, cors);
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return c.json(rpcError(null, -32600, 'Invalid Request'), 400, cors);
  }
  const hasId = msg.id !== undefined;
  if (hasId && typeof msg.id !== 'string' && typeof msg.id !== 'number') {
    return c.json(rpcError(null, -32600, 'Invalid Request: id must be a string or number'), 400, cors);
  }
  const id: JsonRpcId = hasId ? msg.id : null;
  const method: string = msg.method;
  const params: Record<string, any> = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
  const meta: Record<string, any> = params._meta && typeof params._meta === 'object' ? params._meta : {};

  // 通知には本文なしで202（このサーバーが受けて意味のある通知は無い）
  if (!hasId) return new Response(null, { status: 202, headers: cors });

  const headerVersion = c.req.header('MCP-Protocol-Version');
  const metaVersion = meta[META_VERSION];

  // ---------- 時代の判定 ----------
  // _meta に protocolVersion があれば新方式。無く、MCP-Protocol-Version が新方式の版を指すなら不備。それ以外は従来方式。
  const isModern = metaVersion !== undefined || headerVersion === MODERN;

  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => c.json(body as object, status as 200, { ...cors, ...extra });

  if (isModern) {
    if (typeof metaVersion !== 'string' || meta[META_CAPS] === undefined || typeof meta[META_CAPS] !== 'object') {
      return reply(rpcError(id, -32602, 'Invalid params: _meta must include io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities'), 400);
    }
    if (!headerVersion || headerVersion !== metaVersion) {
      return reply(rpcError(id, -32020, `Header mismatch: MCP-Protocol-Version header '${headerVersion ?? ''}' does not match body '${metaVersion}'`), 400);
    }
    if (metaVersion !== MODERN) {
      return reply(rpcError(id, -32022, 'Unsupported protocol version', { supported: ALL_VERSIONS, requested: metaVersion }), 400);
    }
    if (c.req.header('Mcp-Method') !== method) {
      return reply(rpcError(id, -32020, `Header mismatch: Mcp-Method header does not match body method '${method}'`), 400);
    }
    if (method === 'tools/call') {
      const raw = c.req.header('Mcp-Name');
      const decoded = raw === undefined ? null : decodeHeaderValue(raw);
      if (decoded === null || decoded !== params.name) {
        return reply(rpcError(id, -32020, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), 400);
      }
    }
  } else if (headerVersion !== undefined && !LEGACY.includes(headerVersion)) {
    return reply(rpcError(id, -32022, 'Unsupported protocol version', { supported: ALL_VERSIONS, requested: headerVersion }), 400);
  }

  // 新方式の結果には resultType と serverInfo を付ける
  const ok = (result: Record<string, unknown>) =>
    reply({
      jsonrpc: '2.0',
      id,
      result: isModern ? { resultType: 'complete', ...result, _meta: { ...(result._meta as object | undefined), [META_SERVER]: SERVER_INFO } } : result,
    });

  // ---------- メソッド ----------
  switch (method) {
    case 'initialize': {
      if (isModern) break; // 新方式には無いメソッド（下で404）
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok({
        protocolVersion: LEGACY.includes(requested) ? requested : LEGACY[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      if (isModern) break;
      return ok({});
    case 'server/discover':
      if (!isModern) break;
      return ok({
        supportedVersions: ALL_VERSIONS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: 'public',
      });
    case 'tools/list': {
      // 付与された権限で使えるツールだけを見せる（権限で一覧が変わるのでキャッシュは private）
      const tools = TOOLS.filter((t) => auth.scopes.has(t.scope)).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      }));
      return ok(isModern ? { tools, ttlMs: 60_000, cacheScope: 'private' } : { tools });
    }
    case 'tools/call': {
      const tool = typeof params.name === 'string' ? TOOLS_BY_NAME.get(params.name) : undefined;
      if (!tool) return reply(rpcError(id, -32602, `Unknown tool: ${String(params.name).slice(0, 80)}`));
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return reply(rpcError(id, -32602, 'Invalid params: arguments must be an object'));
      }
      if (!auth.scopes.has(tool.scope)) {
        return reply(rpcError(id, -32001, `Insufficient scope: ${tool.scope} is required`), 403, {
          'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${tool.scope}", resource_metadata="${metadataUrl}", error_description="${tool.scope} permission required"`,
        });
      }
      try {
        const out = await tool.run({ env: c.env, userId: auth.userId }, args as Record<string, unknown>);
        return ok({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        if (e instanceof ToolError) {
          return ok({ content: [{ type: 'text', text: e.message }], isError: true });
        }
        console.error('mcp tool failed', tool.name, e);
        return ok({ content: [{ type: 'text', text: 'internal error' }], isError: true });
      }
    }
  }

  // 未実装のメソッド。新方式は404（レガシーのHTTP+SSEサーバーと区別するためJSON-RPCエラーを付ける）、従来方式は200＋エラー
  return reply(rpcError(id, -32601, `Method not found: ${method.slice(0, 80)}`), isModern ? 404 : 200);
});

export default app;
