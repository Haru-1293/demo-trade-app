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
app.get('/api/proxy', async (c) => {
  if (c.env.USE_WORKER_PROXY !== 'true') {
    return c.notFound();
  }
  // TODO: services/marketData.ts の fetchChart を呼び出し、
  // CORSヘッダー（Access-Control-Allow-Origin, Access-Control-Allow-Credentials）を付与して返す
  return c.json({ error: 'not implemented' }, 501);
});

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default app;
