import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { pool, migrate } from './db.js';
import todosRouter from './routes/todos.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();

app.set('trust proxy', 1); // behind nginx on EC2
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // The app is commonly first served over plain HTTP on an EC2 IP;
        // upgrading subresources to https would break it there.
        upgradeInsecureRequests: null,
      },
    },
    // HSTS only makes sense once you terminate TLS (ALB / certbot).
    strictTransportSecurity: process.env.ENABLE_HSTS === 'true',
  })
);
app.use(compression());
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

app.use('/api/todos', todosRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// Three.js is served straight from node_modules — no CDN or bundler needed.
app.use(
  '/vendor/three',
  express.static(path.join(root, 'node_modules/three/build'), { maxAge: '7d', immutable: true })
);
app.use(express.static(path.join(root, 'public'), { maxAge: '1h' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

async function start() {
  try {
    await migrate();
    console.log('[db] schema ready');
  } catch (err) {
    const target = `${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}`;
    console.error(`[db] failed to connect / migrate (${target}):`, err.code || '', err.message);
    process.exit(1);
  }

  const server = app.listen(port, host, () => {
    console.log(`Orbit Todo listening on http://${host}:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
