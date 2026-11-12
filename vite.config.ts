import type { IncomingMessage } from 'node:http';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadApiKey } from './scripts/apiKey.ts';

const FORWARDED = ['content-type', 'anthropic-version', 'anthropic-beta'];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Lets the AI player in the browser reach the Claude API without the key ever
 * leaving this machine's dev server: the page posts to /api/anthropic and the
 * key is added here. Only the Messages endpoint is forwarded, and only while
 * `npm run dev` is running; a built copy of the game has no such route.
 */
function aiProxy(): Plugin {
  return {
    name: 'shiftworks-ai-proxy',
    configureServer(server) {
      server.middlewares.use('/api/ai-status', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ available: loadApiKey() !== null }));
      });
      server.middlewares.use('/api/anthropic', async (req, res) => {
        const key = loadApiKey();
        if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('content-type', 'application/json');
        if (!key) {
          res.statusCode = 401;
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'The dev server has no API key.' } }));
          return;
        }
        try {
          const headers: Record<string, string> = { 'x-api-key': key };
          for (const name of FORWARDED) {
            const value = req.headers[name];
            if (typeof value === 'string') headers[name] = value;
          }
          const body = await readBody(req);
          const upstream = await fetch(`https://api.anthropic.com${req.url}`, { method: 'POST', headers, body: new Uint8Array(body) });
          res.statusCode = upstream.status;
          for (const name of ['content-type', 'request-id', 'retry-after']) {
            const value = upstream.headers.get(name);
            if (value) res.setHeader(name, value);
          }
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Could not reach the Claude API: ${(error as Error).message}` } }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), aiProxy()],
  server: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
