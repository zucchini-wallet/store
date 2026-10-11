import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { SOLANA_USDC } from '../src/solana-settlement.mjs';

// Use Wrangler's installed local workerd/SQLite runtime. Explicit synthetic
// bindings avoid Wrangler config discovery and .dev.vars; outbound IO is denied.
const version = '00000000-0000-4000-8000-000000000001';
const uuidKey = 'cryptorefills:US:20000000-0000-4000-8000-000000000002';
const legacyRecords = [2, 42].map((voucherId) => ({
  voucherId,
  brandName: `Fixture ${voucherId}`,
  name: 'Synthetic gift card',
  countryCode: 'US',
  currency: 'USD',
  denominationMode: 'FIXED',
  denominations: [5],
  minAmount: 5,
  maxAmount: 5,
}));
const legacyMeta = JSON.stringify({
  version,
  fetchedAt: '2026-10-01T00:00:00Z',
  provider: '0fiat',
});
const introspection = `
function snapshot(sql) {
  return {
    columns: sql.exec('PRAGMA table_info(catalog)').toArray(),
    catalog: sql.exec('SELECT version,id,data FROM catalog ORDER BY version,id').toArray(),
    orders: sql.exec('SELECT id,token,data FROM orders ORDER BY id').toArray(),
    receipts: sql.exec('SELECT id,order_id FROM receipts ORDER BY id').toArray(),
    metadata: sql.exec('SELECT key,value FROM metadata ORDER BY key').toArray(),
    temporaryTables: sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_strings'").toArray(),
  };
}
const entrypoint = { fetch(request,env) {
  return env.STORE.get(env.STORE.idFromName('synthetic-catalog-migration')).fetch(request);
}};
`;
const seedScript = `
import { DurableObject } from 'cloudflare:workers';
${introspection}
export class Store extends DurableObject {
  constructor(ctx,env) { super(ctx,env); this.ctx=ctx; }
  async fetch(request) {
    const sql=this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec('CREATE TABLE orders(id TEXT PRIMARY KEY,token TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE receipts(id TEXT PRIMARY KEY,order_id TEXT NOT NULL); CREATE TABLE catalog(version TEXT NOT NULL,id INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(version,id)); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
      for(const record of ${JSON.stringify(legacyRecords)})
        sql.exec('INSERT INTO catalog VALUES(?,?,?)',${JSON.stringify(version)},record.voucherId,JSON.stringify(record));
      sql.exec('INSERT INTO orders VALUES(?,?,?)','fixture-order','fixture-token-hash','opaque existing encrypted-order bytes');
      sql.exec('INSERT INTO receipts VALUES(?,?)','fixture-receipt','fixture-order');
      sql.exec('INSERT INTO metadata VALUES(?,?)','catalog',${JSON.stringify(legacyMeta)});
      sql.exec('INSERT INTO metadata VALUES(?,?)','unrelated','synthetic metadata bytes');
    });
    return Response.json(snapshot(sql));
  }
}
export default entrypoint;
`;
async function productionScript() {
  const result = await build({
    stdin: {
      contents: `
import { Store as ProductionStore } from './cloudflare/worker.mjs';
${introspection}
export class Store extends ProductionStore {
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/insert-string') {
      const record=await request.json();
      this.ctx.storage.sql.exec('INSERT INTO catalog VALUES(?,?,?)',record.version,record.id,JSON.stringify(record.data));
      return Response.json({ok:true});
    }
    if(path==='/inspect') return Response.json(snapshot(this.ctx.storage.sql));
    return super.fetch(request);
  }
}
export default entrypoint;
`,
      resolveDir: resolve(new URL('..', import.meta.url).pathname),
      sourcefile: 'synthetic-catalog-migration-entry.mjs',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['cloudflare:*', 'node:*'],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}
test('local Worker migrates INTEGER catalog identities to TEXT without losing data and remains restart-safe', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zucchini-worker-catalog-migration-'));
  let runtime;
  t.after(async () => {
    await runtime?.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const options = (script) =>
    convertV4MiniflareOptions({
      name: 'synthetic-catalog-migration',
      script,
      modules: true,
      compatibilityDate: '2026-09-14',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { STORE: { className: 'Store', useSQLite: true } },
      resourcePersistencePath: dir,
      bindings: {
        PUBLIC_ORIGIN: 'https://store.example',
        NETWORK: 'mainnet',
        GIFT_CARD_PROVIDER: '0fiat',
        FUNDING_MODE: 'prepaid',
        CHECKOUT_ENABLED: 'false',
        FULFILLMENT_ENABLED: 'false',
        DATA_ENCRYPTION_KEY: 'e'.repeat(64),
        ADMIN_TOKEN: 'c'.repeat(32),
      },
      cf: false,
      unsafeRegisterWorker: false,
      log: new Log(LogLevel.ERROR),
      outboundService: () => assert.fail('Migration test must never make outbound requests'),
    });
  const inspect = async () => {
    const response = await runtime.dispatchFetch('https://migration.example/inspect');
    assert.equal(response.status, 200);
    return response.json();
  };
  runtime = new Miniflare(options(seedScript));
  const before = await inspect();
  assert.equal(before.columns.find((column) => column.name === 'id').type, 'INTEGER');
  assert.deepEqual(
    before.catalog.map((row) => row.id),
    [2, 42],
  );
  const script = await productionScript();
  await runtime.setOptions(options(script));
  const migrated = await inspect();
  assert.equal(migrated.columns.find((column) => column.name === 'id').type, 'TEXT');
  assert.deepEqual(
    migrated.catalog,
    before.catalog.map((row) => ({ ...row, id: String(row.id) })),
  );
  for (const table of ['orders', 'receipts', 'metadata'])
    assert.deepEqual(migrated[table], before[table]);
  assert.deepEqual(migrated.temporaryTables, []);
  const publicCatalog = await runtime.dispatchFetch(
    'https://migration.example/api/catalog?country=US',
  );
  assert.equal(publicCatalog.status, 200);
  assert.deepEqual(
    (await publicCatalog.json()).items.map((record) => record.voucherId).sort((a, b) => a - b),
    [2, 42],
  );
  const inserted = await runtime.dispatchFetch('https://migration.example/insert-string', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 'synthetic-other-version',
      id: uuidKey,
      data: { synthetic: true },
    }),
  });
  assert.equal(inserted.status, 200);
  const withString = await inspect();
  assert.equal(withString.catalog.find((row) => row.id === uuidKey).id, uuidKey);
  await runtime.dispose();
  runtime = new Miniflare(options(script));
  assert.deepEqual(await inspect(), withString);
});

test('configured direct Worker initializes gateway Ed25519 keys and reports blocked readiness without service IO', async (t) => {
  // A public synthetic installation identity; this is not a wallet or payment key.
  const installationSeed = Buffer.alloc(32, 7).toString('base64url');
  const primaryKey = 'synthetic-cryptorefills-primary';
  const adminToken = 'c'.repeat(32);
  let outboundCalls = 0;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'synthetic-configured-direct-store',
      script: await productionScript(),
      modules: true,
      compatibilityDate: '2026-09-14',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { STORE: { className: 'Store', useSQLite: true } },
      bindings: {
        PUBLIC_ORIGIN: 'https://store.example',
        NETWORK: 'mainnet',
        GIFT_CARD_PROVIDER: 'cryptorefills',
        FUNDING_MODE: 'direct_swap',
        CHECKOUT_ENABLED: 'false',
        FULFILLMENT_ENABLED: 'false',
        DATA_ENCRYPTION_KEY: 'e'.repeat(64),
        ADMIN_TOKEN: adminToken,
        CRYPTOREFILLS_PARTNER_KEY: primaryKey,
        CRYPTOREFILLS_PARTNER_ID: 'synthetic-partner',
        GATEWAY_INSTALLATION_SEED: installationSeed,
        GATEWAY_ORIGIN: 'https://gateway.example',
        GATEWAY_APP_ID: 'store.example',
        SOLANA_RPC_URL: 'https://solana.example',
      },
      cf: false,
      unsafeRegisterWorker: false,
      log: new Log(LogLevel.ERROR),
      outboundService: () => {
        outboundCalls++;
        assert.fail('Configured constructor and readiness reads must not call a service');
      },
    }),
  );
  t.after(() => runtime.dispose());
  const configResponse = await runtime.dispatchFetch('https://store.example/api/config');
  assert.equal(
    configResponse.status,
    200,
    'Actual Worker constructor must initialize successfully',
  );
  const config = await configResponse.json();
  assert.equal(config.fundingMode, 'direct_swap');
  assert.equal(config.giftCardProvider, 'cryptorefills');
  assert.equal(config.checkoutReady, false);
  const unauthorized = await runtime.dispatchFetch('https://store.example/internal/health');
  assert.equal(unauthorized.status, 401);
  const healthResponse = await runtime.dispatchFetch('https://store.example/internal/health', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.checkoutEnabled, false);
  assert.equal(health.providerConnectivityVerified, false);
  const readiness = health.runtimeReadiness;
  assert.equal(readiness.keyConfigured, true);
  assert.equal(readiness.gatewayConfigured, true);
  assert.equal(readiness.solanaConfigured, true);
  assert.equal(readiness.coordinatorImplemented, true);
  assert.equal(readiness.schemaConfigured, false);
  assert.equal(readiness.readyForFundsTest, false);
  assert.equal(readiness.checkoutActivatable, false);
  for (const privateValue of [installationSeed, primaryKey, adminToken])
    assert.equal(JSON.stringify({ config, health }).includes(privateValue), false);
  assert.equal(outboundCalls, 0);
});

test('actual direct Worker reads finalized Solana height through bounded JSON-RPC with preserved response IDs', async (t) => {
  const adminToken = 'c'.repeat(32);
  const requests = [];
  const attemptedRequests = [];
  let redirectResponse = false;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'synthetic-direct-solana-rpc',
      script: await productionScript(),
      modules: true,
      compatibilityDate: '2026-09-14',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { STORE: { className: 'Store', useSQLite: true } },
      bindings: {
        PUBLIC_ORIGIN: 'https://store.example',
        NETWORK: 'mainnet',
        GIFT_CARD_PROVIDER: 'cryptorefills',
        FUNDING_MODE: 'direct_swap',
        CHECKOUT_ENABLED: 'false',
        FULFILLMENT_ENABLED: 'false',
        DATA_ENCRYPTION_KEY: 'e'.repeat(64),
        ADMIN_TOKEN: adminToken,
        CRYPTOREFILLS_PARTNER_KEY: 'synthetic-cryptorefills-primary',
        GATEWAY_INSTALLATION_SEED: Buffer.alloc(32, 7).toString('base64url'),
        GATEWAY_ORIGIN: 'https://gateway.example',
        GATEWAY_APP_ID: 'store.example',
        SOLANA_RPC_URL: 'https://solana.example',
      },
      cf: false,
      unsafeRegisterWorker: false,
      log: new Log(LogLevel.ERROR),
      async outboundService(request) {
        attemptedRequests.push({ url: request.url, method: request.method });
        assert.equal(
          request.url,
          'https://solana.example/',
          'Only the synthetic Solana endpoint is allowed',
        );
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.get('Content-Type'), 'application/json');
        const body = await request.json();
        assert.equal(body.jsonrpc, '2.0');
        assert.ok(Number.isSafeInteger(body.id) && body.id > 0);
        assert.ok(['getGenesisHash', 'getBlockHeight'].includes(body.method));
        requests.push(body);
        if (redirectResponse) {
          return new Response(null, {
            status: 307,
            headers: { Location: 'https://must-not-follow.example/' },
          });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: body.method === 'getGenesisHash' ? SOLANA_USDC.genesisHash : 123456,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    }),
  );
  t.after(() => runtime.dispose());
  const unauthorized = await runtime.dispatchFetch('https://store.example/internal/solana-height');
  assert.equal(unauthorized.status, 401);
  assert.equal(requests.length, 0);
  const response = await runtime.dispatchFetch('https://store.example/internal/solana-height', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { blockHeight: 123456 });
  assert.deepEqual(requests, [
    { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'getBlockHeight', params: [{ commitment: 'finalized' }] },
  ]);
  redirectResponse = true;
  const redirected = await runtime.dispatchFetch('https://store.example/internal/solana-height', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(redirected.status, 503);
  assert.equal((await redirected.json()).error, 'Solana RPC check failed.');
  assert.deepEqual(requests[2], {
    jsonrpc: '2.0',
    id: 3,
    method: 'getGenesisHash',
    params: [],
  });
  assert.deepEqual(
    attemptedRequests,
    Array.from({ length: 3 }, () => ({ url: 'https://solana.example/', method: 'POST' })),
    'Redirect responses must not be followed or request finalized height',
  );
});
