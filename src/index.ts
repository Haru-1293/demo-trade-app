import { Hono } from 'hono';
import type { Env } from './types';
import authRoutes from './routes/auth';
import orderRoutes from './routes/orders';
import portfolioRoutes from './routes/portfolio';
import fxRoutes from './routes/fx';
import adminRoutes from './routes/admin';
import symbolsRoutes from './routes/symbols';
import mypageRoutes from './routes/mypage';
import cashTopupRoutes from './routes/cashTopup';
import pricesRoutes from './routes/prices';
import passkeyRoutes from './routes/passkey';
import adminAuthRoutes from './routes/adminAuth';
import { requireAuth } from './middleware/auth';
import { syncSymbols } from './services/symbolSync';
import { takeAssetSnapshots } from './services/snapshot';
import { SECURITY_HEADERS } from './services/securityHeaders';
import { sanitizeClientMessage } from './services/liveFilter';
import { HTTPException } from 'hono/http-exception';

const app = new Hono<{ Bindings: Env }>();

// 全レスポンスにセキュリティヘッダーを付与する（仕様書6.）。静的ファイルは public/_headers で同じ内容を付与する。
// 101(WebSocketアップグレード)はヘッダー操作の制約があるため除外する。
app.use('*', async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!c.res.headers.has(name)) c.res.headers.set(name, value);
  }
});

// 認証必須APIは Cache-Control: no-store を強制（仕様書6.）
// ただし101(WebSocketアップグレード)レスポンスはヘッダー操作の制約があるため除外する
app.use('/api/*', async (c, next) => {
  await next();
  if (c.res.status !== 101 && !c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store');
  }
});

app.route('/api', authRoutes);
app.route('/api', orderRoutes);
app.route('/api', portfolioRoutes);
app.route('/api', symbolsRoutes);
app.route('/api', mypageRoutes);
app.route('/api', cashTopupRoutes);
app.route('/api', pricesRoutes);
app.route('/api/passkey', passkeyRoutes);
app.route('/api/fx', fxRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/admin-auth', adminAuthRoutes);

// USE_WORKER_PROXY=true の間だけ有効な市場データプロキシ（仕様書5.）
const ALLOWED_PROXY_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

app.get('/api/proxy', requireAuth, async (c) => {
  if (c.env.USE_WORKER_PROXY !== 'true') {
    return c.notFound();
  }
  const target = c.req.query('url');
  if (!target) return c.json({ error: 'missing url' }, 400);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return c.json({ error: 'invalid url' }, 400);
  }
  // https のチャートAPIだけを中継する（任意のパス・スキームを許さない）
  if (
    parsed.protocol !== 'https:' ||
    !ALLOWED_PROXY_HOSTS.includes(parsed.hostname) ||
    !parsed.pathname.startsWith('/v8/finance/chart/')
  ) {
    return c.json({ error: 'host not allowed' }, 403);
  }

  const upstream = await fetch(parsed.toString(), {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
});

/**
 * WS /api/live-prices — 仕様書4.8
 * ホーム画面のライブ株価表示（表示専用）のためのWebSocketパススルー。
 * クライアントは自分のドメインにだけ接続すればよく、Yahoo Financeの非公式エンドポイントを
 * 直接知る必要がない。1クライアント接続につき1本の上流接続を張るだけの単純な中継で、
 * 複数クライアント間で1本の上流接続を共有するわけではないため Durable Objects は不要。
 * 約定判定・残高計算には一切使わない（4.2〜4.4のHTTP取得のみが引き続き正）。
 */
app.get('/api/live-prices', requireAuth, async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'expected websocket upgrade' }, 426);
  }
  // 他サイトのページからの接続（Cross-Site WebSocket Hijacking）を拒否する。ブラウザは必ずOriginを付ける。
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: 'forbidden origin' }, 403);
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  let upstream: WebSocket | undefined;
  try {
    const clientUserAgent = c.req.header('User-Agent') ?? 'Mozilla/5.0';
    const upstreamResp = await fetch('https://streamer.finance.yahoo.com/?version=2', {
      headers: {
        Upgrade: 'websocket',
        // ブラウザは`fetch()`からOriginを上書きできないが、Workersはサーバーサイド実行のため
        // 明示的に指定できる。本家のブラウザクライアントと同じOriginを送ることで、
        // Origin検証がある場合でも弾かれにくくする（保険。無くても動く可能性は高い）。
        Origin: 'https://finance.yahoo.com',
        // User-Agentは固定値ではなく、実際に接続してきたクライアントのものをそのままパススルーする
        'User-Agent': clientUserAgent,
      },
    });
    upstream = upstreamResp.webSocket ?? undefined;
  } catch {
    upstream = undefined;
  }

  server.accept();

  if (!upstream) {
    // 上流に繋がらなくてもクライアント側は静的表示にフォールバックできるよう、
    // エラーで落とさず単に接続を閉じるだけにする
    server.close(1011, 'upstream unavailable');
    return new Response(null, { status: 101, webSocket: client });
  }
  upstream.accept();

  // クライアント→上流は、subscribe/unsubscribe（形式の正しいシンボルのみ、購読数上限あり）だけを中継する
  const subscribed = new Set<string>();
  server.addEventListener('message', (event) => {
    const forward = sanitizeClientMessage(event.data, subscribed);
    if (forward === null) return;
    try {
      upstream!.send(forward);
    } catch {
      /* noop */
    }
  });
  upstream.addEventListener('message', (event) => {
    try {
      server.send(event.data as string);
    } catch {
      /* noop */
    }
  });
  server.addEventListener('close', () => {
    try {
      upstream!.close();
    } catch {
      /* noop */
    }
  });
  upstream.addEventListener('close', (event) => {
    try {
      server.close(event.code, event.reason);
    } catch {
      /* noop */
    }
  });
  server.addEventListener('error', () => {
    try {
      upstream!.close();
    } catch {
      /* noop */
    }
  });
  upstream.addEventListener('error', () => {
    try {
      server.close();
    } catch {
      /* noop */
    }
  });

  return new Response(null, { status: 101, webSocket: client });
});

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

/**
 * 未捕捉の例外を一律でJSONの500として返す。
 * これが無いと、ルートハンドラ内の例外がCloudflareの素のHTMLエラーページとして
 * ブラウザに返ってしまい、フロント側で原因が全く分からなくなる
 * （WebAuthn検証の例外がこの経路で発生していたため追加した）。
 */
app.onError((err, c) => {
  // Honoが投げる意図的なHTTP例外（不正なJSON等）はそのステータスで返す
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof SyntaxError) return c.json({ error: 'invalid body' }, 400);
  // 内部のエラーメッセージ（SQL・ライブラリの詳細など）は利用者に返さず、サーバーのログにだけ残す
  console.error('unhandled error', err);
  return c.json({ error: 'internal server error' }, 500);
});

export default {
  fetch: app.fetch,

  /**
   * Cronトリガー: 毎日08:30(JST) = 23:30(UTC)に銘柄マスタ(symbols)を同期する。
   * wrangler.json の triggers.crons を参照。
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncSymbols(env).then((result) => {
        if (result.errors.length > 0) {
          console.error('symbol sync completed with errors', result);
        } else {
          console.log('symbol sync completed', result.jpCount, result.usCount);
        }
      }),
    );
    // 仕様書7.4: 銘柄マスタ同期と同じタイミングで、全ユーザー分の日次資産スナップショットを記録する
    ctx.waitUntil(
      takeAssetSnapshots(env)
        .then((r) => {
          if (r.skipped) console.error('asset snapshot skipped:', r.skipped);
          else console.log('asset snapshot completed', r.count);
        })
        .catch((e) => console.error('asset snapshot failed', e)),
    );
  },
};
