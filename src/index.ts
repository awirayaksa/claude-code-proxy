import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { chatRouter } from './routes/chat';
import { modelsRouter } from './routes/models';
import { sessionManager } from './session/manager';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
  exposedHeaders: ['X-Session-Id'],
}));

app.use(express.json({ limit: '4mb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    sessions: sessionManager.size,
  });
});

app.use('/v1', chatRouter);
app.use('/v1', modelsRouter);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: { type: 'not_found', message: 'Route not found' } });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server error]', err);
  res.status(500).json({ error: { type: 'server_error', message: 'Internal server error' } });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, HOST, () => {
  console.log(`Claude Code Proxy running at http://${HOST}:${PORT}`);
  console.log(`Endpoint: http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`Health:   http://${HOST}:${PORT}/health`);
  console.log(`Models:   http://${HOST}:${PORT}/v1/models`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  console.log('\nShutting down...');
  sessionManager.disposeAll();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Force exit after 5s if server hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
