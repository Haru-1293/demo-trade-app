import { Hono } from 'hono';
import type { Env } from './types';
import authRoutes from './routes/auth';
import orderRoutes from './routes/orders';
import portfolioRoutes from './routes/portfolio';
import fxRoutes from './routes/fx';
import adminRoutes from './routes/admin';

const app = new Hono<{ Bindings: Env }>();

// 認証必須APIは Cache-Control: no-store を強制（仕様書6.）
app.use('/api/*', async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store');
  }
});

app.route('/api', authRoutes);
app.route('/api', orderRoutes);
app.route('/api', portfolioRoutes);
app.route('/api/fx', fxRoutes);
app.route('/api/admin', adminRoutes);

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

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default app;
