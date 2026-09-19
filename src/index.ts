import { Hono } from 'hono';
import type { Env } from './types';
import authRoutes from './routes/auth';
import orderRoutes from './routes/orders';
import portfolioRoutes from './routes/portfolio';
import fxRoutes from './routes/fx';
import adminRoutes from './routes/admin';
import symbolsRoutes from './routes/symbols';
import adminAuthRoutes from './routes/adminAuth';
import { requireAuth } from './middleware/auth';

const app = new Hono<{ Bindings: Env }>();

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
app.route('/api/fx', fxRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/admin-auth', adminAuthRoutes);

// USE_WORKER_PROXY=true の間だけ有効な市場データプロキシ（仕様書5.）
const ALLOWED_PROXY_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

app.get('/api/proxy', async (c) => {
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
  if (!ALLOWED_PROXY_HOSTS.includes(parsed.hostname)) {
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
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
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

  server.addEventListener('message', (event) => {
    try {
      upstream!.send(event.data as string);
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

export default app;
