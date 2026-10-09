import { createRuntimeSettlement } from './runtime-settlement.mjs';
import { credentials } from './credentials.mjs';
import { createApp } from './application.mjs';
import { catalogPage, cleanCatalog } from './catalog.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig, secureEqual } from './config.mjs';
import { createStore } from './storage.mjs';
import { createProvider } from './provider.mjs';
import { validateFace, priceOrder, paymentUri, reconcile, InputError } from './domain.mjs';
import { createFulfillment } from './fulfillment.mjs';
import Decimal from 'decimal.js';
const isMain = process.argv[1] && new URL(import.meta.url).pathname === resolve(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  if (!config.encryptionKey) {
    if (config.checkoutEnabled) throw Error('Encryption key required');
    const p = resolve(config.dataDir, 'local-encryption-key');
    try {
      config.encryptionKey = (await readFile(p, 'utf8')).trim();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      config.encryptionKey = randomBytes(32).toString('hex');
      await writeFile(p, config.encryptionKey, { mode: 0o600, flag: 'wx' });
    }
  }
  const store = createStore(resolve(config.dataDir, 'store.sqlite'), config.encryptionKey);
  let catalog;
  try {
    catalog = JSON.parse(await readFile(resolve(config.dataDir, 'catalog.json'), 'utf8'));
    catalog.vouchers = cleanCatalog(catalog.vouchers);
  } catch {
    catalog = { fetchedAt: null, vouchers: [] };
  }
  const provider =
    config.giftCardProvider === '0fiat' && config.providerFile
      ? createProvider(await credentials(config.providerFile))
      : undefined;
  const fulfillment = provider ? createFulfillment({ store, provider, config }) : undefined;
  const runtime =
    config.giftCardProvider === 'cryptorefills'
      ? createRuntimeSettlement({ config, env: process.env })
      : {};
  const app = createApp({
    config,
    store,
    provider: runtime.provider ?? provider,
    catalog,
    ...runtime,
  });
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/internal/'))
      return app.handler(req, res);
    const path = new URL(req.url, config.origin).pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (req.method !== 'GET' || !/^[-a-zA-Z0-9_.]+$/.test(file)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    try {
      const bytes = await readFile(resolve('dist', file));
      res.writeHead(200, {
        'Content-Type':
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.woff2': 'font/woff2',
          }[extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://0fiat.com https://cdn.cryptorefills.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'Referrer-Policy': 'no-referrer',
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  server.listen(config.port, '127.0.0.1', () =>
    console.log(
      `Zucchini Store: http://127.0.0.1:${config.port} (checkout ${config.checkoutEnabled ? 'enabled' : 'disabled'})`,
    ),
  );
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await app.tick();
      await fulfillment?.tick();
    } catch {
      console.error('Background recovery unavailable');
    } finally {
      ticking = false;
    }
  }, 15000);
  timer.unref();
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      clearInterval(timer);
      server.close(() => {
        store.close();
        process.exit(0);
      });
    });
}
