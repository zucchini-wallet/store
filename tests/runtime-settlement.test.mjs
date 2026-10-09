import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeSettlement } from '../src/runtime-settlement.mjs';
import { loadConfig } from '../src/config.mjs';
import { catalogProvider } from '../src/catalog.mjs';
const env = {
  GIFT_CARD_PROVIDER: 'cryptorefills',
  CHECKOUT_ENABLED: 'false',
  CRYPTOREFILLS_PARTNER_KEY: 'synthetic-private-key',
};

test('Worker runtime consumes private key without requests and reports remaining blockers', () => {
  const runtime = createRuntimeSettlement({
    config: loadConfig(env),
    env,
    fetcher: () => {
      throw Error('No constructor IO permitted');
    },
  });
  assert.equal(runtime.runtimeReadiness.keyConfigured, true);
  assert.equal(runtime.runtimeReadiness.checkoutActivatable, false);
  assert.equal(runtime.provider, undefined);
  assert.equal(runtime.cryptorefillsAdapters, undefined);
  assert.ok(runtime.runtimeReadiness.blockers.includes('reviewed_v6_response_and_price_mappings'));
  assert.ok(!JSON.stringify(runtime.runtimeReadiness).includes(env.CRYPTOREFILLS_PARTNER_KEY));
});
test('configured read transports cannot claim production readiness or omit response review', () => {
  const values = {
    ...env,
    GATEWAY_ORIGIN: 'https://gateway.example',
    GATEWAY_SESSION_TOKEN: 's'.repeat(40),
    SOLANA_RPC_URL: 'https://rpc.example',
    BUFFER_ADDRESS: '11111111111111111111111111111111',
    SOLANA_MAX_FEE_LAMPORTS: '5000',
    SOLANA_MAX_RENT_LAMPORTS: '0',
  };
  const runtime = createRuntimeSettlement({
    config: loadConfig(values),
    env: values,
    fetcher: () => {
      throw Error('No IO');
    },
  });
  assert.equal(runtime.runtimeReadiness.gatewayConfigured, true);
  assert.equal(runtime.runtimeReadiness.solanaConfigured, true);
  assert.equal(typeof runtime.settlementAdapters.quote, 'function');
  assert.equal(runtime.cryptorefillsAdapters, undefined);
  assert.equal(runtime.runtimeReadiness.schemaConfigured, false);
  assert.equal(typeof runtime.getSolanaBlockHeight, 'function');
});
test('provider catalog identity survives explicit normalization and rejects unsupported providers', () => {
  const metadata = JSON.parse(
    JSON.stringify({ version: 'example', provider: catalogProvider('cryptorefills') }),
  );
  assert.equal(metadata.provider, 'cryptorefills');
  assert.equal(catalogProvider(), '0fiat');
  assert.throws(() => catalogProvider('unknown'));
});

test('selected direct flow never composes merchant custody and cannot be activated by flags or old bindings', () => {
  const values = {
    ...env,
    FUNDING_MODE: 'direct_swap',
    CRYPTOREFILLS_PARTNER_ID: 'synthetic-public-id',
    CRYPTOREFILLS_BACKUP_PARTNER_KEY: 'second-synthetic-private-key',
    GATEWAY_ORIGIN: 'https://gateway.example',
    GATEWAY_SESSION_TOKEN: 's'.repeat(40),
    SOLANA_RPC_URL: 'https://rpc.example',
    BUFFER_ADDRESS: '11111111111111111111111111111111',
    SOLANA_MAX_FEE_LAMPORTS: '5000',
    SOLANA_MAX_RENT_LAMPORTS: '0',
    SCANNER_READY: 'true',
  };
  const runtime = createRuntimeSettlement({
    config: loadConfig(values),
    env: values,
    mappings: { quoteProduct() {}, payment() {}, delivery() {} },
    verifyReply() {},
    fetcher: () => {
      throw Error('No construction IO');
    },
  });
  assert.equal(runtime.runtimeReadiness.fundingMode, 'direct_swap');
  assert.equal(runtime.runtimeReadiness.backupKeyConfigured, true);
  assert.equal(runtime.runtimeReadiness.solanaConfigured, true);
  assert.equal(runtime.runtimeReadiness.checkoutActivatable, false);
  assert.equal(runtime.runtimeReadiness.gatewayConfigured, false);
  assert.equal(runtime.settlementAdapters, undefined);
  assert.equal(runtime.cryptorefillsAdapters, undefined);
  assert.equal(runtime.provider, undefined);
  assert.ok(!runtime.runtimeReadiness.blockers.includes('solana_rpc_buffer_and_fee_policy'));
  assert.ok(
    runtime.runtimeReadiness.blockers.includes('gateway_exact_output_execution_and_recovery'),
  );
  assert.ok(
    !JSON.stringify(runtime.runtimeReadiness).includes(values.CRYPTOREFILLS_BACKUP_PARTNER_KEY),
  );
  assert.throws(() => loadConfig({ ...values, CHECKOUT_ENABLED: 'true' }), /blocked/);
  assert.throws(() => loadConfig({ FUNDING_MODE: 'direct_swap' }), /requires Cryptorefills/);
});

test('disabled Cryptorefills release preserves labelled legacy browsing without authorizing purchase', async () => {
  const { createApp } = await import('../src/application.mjs');
  const { Readable } = await import('node:stream');
  const config = {
    ...loadConfig(env),
    origin: 'https://store.example',
    adminToken: 'a'.repeat(32),
  };
  const app = createApp({
    config,
    store: { all: () => [], close() {} },
    catalog: {
      fetchedAt: new Date().toISOString(),
      vouchers: [
        {
          voucherId: 1,
          name: 'Preview brand',
          brandName: 'Preview brand',
          countryCode: 'US',
          currency: 'USD',
          denominationMode: 'FIXED',
          denominations: [10],
          minAmount: 10,
          maxAmount: 10,
        },
      ],
    },
  });
  async function call(path, method = 'GET') {
    const req = Readable.from([]);
    req.url = path;
    req.method = method;
    req.headers = { origin: config.origin };
    req.socket = { remoteAddress: '192.0.2.1' };
    let status, data;
    await app.handler(req, {
      setHeader() {},
      writeHead(code) {
        status = code;
      },
      end(body) {
        data = JSON.parse(body);
      },
    });
    return { status, data };
  }
  const cfg = await call('/api/config');
  assert.equal(cfg.data.catalogPreview, true);
  assert.equal(cfg.data.catalogProvider, '0fiat');
  assert.equal(cfg.data.checkoutReady, false);
  assert.equal((await call('/api/catalog?country=US')).data.items.length, 1);
  assert.equal((await call('/api/orders', 'POST')).status, 503);
});

test('disabled fulfillment prevents background work and operator preparation', async () => {
  const { createApp } = await import('../src/application.mjs');
  const { Readable } = await import('node:stream');
  const config = {
    ...loadConfig(env),
    origin: 'https://store.example',
    adminToken: 'a'.repeat(32),
  };
  let reads = 0;
  const app = createApp({
    config,
    store: {
      all() {
        reads++;
        return [];
      },
      close() {},
    },
    catalog: { vouchers: [] },
    settlementAdapters: {
      quote() {
        throw Error('No service requests while disabled');
      },
    },
  });
  await app.tick();
  assert.equal(reads, 0);
  const req = Readable.from([
    Buffer.from(JSON.stringify({ orderId: 'example', action: 'prepare_conversion' })),
  ]);
  req.url = '/internal/settlement';
  req.method = 'POST';
  req.headers = { authorization: 'Bearer ' + config.adminToken };
  req.socket = { remoteAddress: '192.0.2.1' };
  let status;
  await app.handler(req, {
    setHeader() {},
    writeHead(code) {
      status = code;
    },
    end() {},
  });
  assert.equal(status, 503);
});
