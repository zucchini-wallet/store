import { createRuntimeSettlement } from '../src/runtime-settlement.mjs';
import { catalogProvider } from '../src/catalog.mjs';
import { Buffer } from 'node:buffer';
import { DurableObject } from 'cloudflare:workers';
import { createApp } from '../src/application.mjs';
import { createEncryptedStore } from '../src/storage-core.mjs';
import { createProvider } from '../src/provider.mjs';
import { loadConfig, secureEqual } from '../src/config.mjs';
import { cleanCatalog } from '../src/catalog.mjs';
import { createFulfillment } from '../src/fulfillment.mjs';
const fail = () =>
  Response.json(
    { error: 'The store is temporarily unavailable. Please try again.' },
    { status: 503 },
  );
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.catalog = { fetchedAt: null, vouchers: [] };
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        'CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,token TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,order_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS catalog(version TEXT NOT NULL,id INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(version,id)); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
      );
      this.config = loadConfig({
        ...env,
        OFIAT_ENV_FILE: env.OFIAT_API_KEY ? 'worker-secret' : undefined,
      });
      this.store = createEncryptedStore(
        {
          close() {},
          prepare(query) {
            return {
              all: (...args) => sql.exec(query, ...args).toArray(),
              get: (...args) => sql.exec(query, ...args).toArray()[0],
              run: (...args) => sql.exec(query, ...args),
            };
          },
          transaction: (fn) => ctx.storage.transactionSync(fn),
        },
        env.DATA_ENCRYPTION_KEY,
      );
      this.provider =
        this.config.giftCardProvider === '0fiat' && env.OFIAT_API_KEY && env.OFIAT_API_SECRET
          ? createProvider({ API_KEY: env.OFIAT_API_KEY, API_SECRET: env.OFIAT_API_SECRET })
          : undefined;
      const runtime =
        this.config.giftCardProvider === 'cryptorefills'
          ? createRuntimeSettlement({ config: this.config, env })
          : {};
      this.reloadCatalog();
      this.app = createApp({
        config: this.config,
        store: this.store,
        provider: runtime.provider ?? this.provider,
        catalog: this.catalog,
        ...runtime,
      });
      this.fulfillment = this.provider
        ? createFulfillment({ store: this.store, provider: this.provider, config: this.config })
        : undefined;
    });
  }
  reloadCatalog() {
    const meta = this.ctx.storage.sql
      .exec('SELECT value FROM metadata WHERE key=?', 'catalog')
      .toArray()[0];
    if (!meta) return;
    const { version, fetchedAt, provider } = JSON.parse(meta.value);
    this.catalog.provider = catalogProvider(provider);
    this.catalog.vouchers = cleanCatalog(
      this.ctx.storage.sql
        .exec('SELECT data FROM catalog WHERE version=? ORDER BY id', version)
        .toArray()
        .map((r) => JSON.parse(r.data)),
    );
    this.catalog.fetchedAt = fetchedAt;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/internal/catalog') {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      if (this.config.adminToken.length < 32 || !secureEqual(token, this.config.adminToken))
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      if (request.method !== 'POST')
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
      const text = await request.text();
      if (text.length > 256000)
        return Response.json({ error: 'Request too large' }, { status: 413 });
      const b = JSON.parse(text);
      const provider = catalogProvider(b.provider);
      if (provider !== this.config.giftCardProvider)
        return Response.json(
          { error: 'Catalog provider does not match configuration' },
          { status: 400 },
        );
      if (!/^[a-f0-9-]{36}$/.test(b.version) || !Number.isFinite(Date.parse(b.fetchedAt)))
        return Response.json({ error: 'Invalid catalog version' }, { status: 400 });
      if (b.records) {
        const records = cleanCatalog(b.records);
        if (records.length > 200) throw Error('Too many records');
        this.ctx.storage.transactionSync(() => {
          for (const v of records)
            this.ctx.storage.sql.exec(
              'INSERT OR REPLACE INTO catalog VALUES(?,?,?)',
              b.version,
              v.voucherId,
              JSON.stringify(v),
            );
        });
      }
      if (b.publish) {
        const count = this.ctx.storage.sql
          .exec('SELECT COUNT(*) AS n FROM catalog WHERE version=?', b.version)
          .toArray()[0].n;
        if (!Number.isSafeInteger(b.count) || count !== b.count || count < 1 || count > 50000)
          throw Error('Incomplete catalog');
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            'INSERT OR REPLACE INTO metadata VALUES(?,?)',
            'catalog',
            JSON.stringify({ version: b.version, fetchedAt: b.fetchedAt, provider }),
          );
          this.ctx.storage.sql.exec('DELETE FROM catalog WHERE version<>?', b.version);
        });
        this.reloadCatalog();
      }
      return Response.json({ ok: true, count: this.catalog.vouchers.length });
    }
    let status = 200,
      headers = new Headers(),
      content;
    const req = {
      url: path + new URL(request.url).search,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      socket: { remoteAddress: request.headers.get('CF-Connecting-IP') ?? 'unknown' },
      async *[Symbol.asyncIterator]() {
        const reader = request.body?.getReader();
        if (!reader) return;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            yield Buffer.from(value);
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
    const res = {
      setHeader: (key, value) => headers.set(key, value),
      writeHead: (code, values) => {
        status = code;
        for (const [k, v] of Object.entries(values ?? {})) headers.set(k, v);
      },
      end: (value) => {
        content = value;
      },
    };
    await this.app.handler(req, res);
    if (
      request.method === 'POST' &&
      this.config.fulfillmentEnabled &&
      !(await this.ctx.storage.getAlarm())
    )
      await this.ctx.storage.setAlarm(Date.now() + 15000);
    return new Response(content, { status, headers });
  }
  async syncCatalog() {
    if (!this.provider) return;
    if (this.catalog.fetchedAt && Date.now() - Date.parse(this.catalog.fetchedAt) < 20 * 3600000)
      return;
    const vouchers = [];
    for (let offset = 0; offset < 50000; offset += 200) {
      const result = await this.provider.request('/vouchers?limit=200&offset=' + offset);
      if (result.settlementCurrency !== 'USD' || !Array.isArray(result.vouchers))
        throw Error('Catalog unavailable');
      vouchers.push(...result.vouchers);
      if (result.vouchers.length < 200) break;
    }
    if (!vouchers.length || vouchers.length >= 50000) throw Error('Catalog incomplete');
    const records = cleanCatalog(vouchers),
      version = crypto.randomUUID(),
      fetchedAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const v of records)
        this.ctx.storage.sql.exec(
          'INSERT INTO catalog VALUES(?,?,?)',
          version,
          v.voucherId,
          JSON.stringify(v),
        );
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO metadata VALUES(?,?)',
        'catalog',
        JSON.stringify({ version, fetchedAt, provider: '0fiat' }),
      );
      this.ctx.storage.sql.exec('DELETE FROM catalog WHERE version<>?', version);
    });
    this.reloadCatalog();
  }
  async alarm() {
    try {
      await this.app.tick();
      await this.fulfillment?.tick();
    } finally {
      if (
        this.store
          .all()
          .some(
            (o) =>
              (o.fundingMode === 'shielded_buffer' &&
                !['reply_confirmed', 'conversion_review'].includes(o.settlement?.state)) ||
              ['payment_pending', 'fulfilling'].includes(o.state) ||
              (o.state === 'delivered' && o.emailOptIn && !o.emailSent && !o.emailNeedsReview),
          )
      )
        await this.ctx.storage.setAlarm(Date.now() + 15000);
    }
  }
}
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      env.STORE.getByName('store-v1')
        .syncCatalog()
        .catch(() => console.error('Gift-card catalog refresh failed; existing catalog retained.')),
    );
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/internal/')) {
      try {
        return await env.STORE.getByName('store-v1').fetch(request);
      } catch {
        return fail();
      }
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://0fiat.com https://cdn.cryptorefills.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  },
};
