import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base58 } from '@scure/base';
import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { createStore } from '../src/storage.mjs';
import { loadConfig } from '../src/config.mjs';
import { createCryptorefillsProvider, CryptorefillsError } from '../src/cryptorefills-provider.mjs';
import { createCryptorefillsSettlement } from '../src/cryptorefills-settlement.mjs';
import { SOLANA_USDC, prepareSolanaUsdcPayment } from '../src/solana-settlement.mjs';
const id = '00000000-0000-4000-8000-000000000001',
  now = 1800000000;
const key = (n) => base58.encode(new Uint8Array(32).fill(n));
const from = key(2),
  to = key(3),
  signature = base58.encode(new Uint8Array(64).fill(7));
const order = () => ({
  id,
  giftCardProvider: 'cryptorefills',
  fundingMode: 'shielded_buffer',
  state: 'payment_pending',
  costUsd: '5.00',
  faceAmount: '5.00',
  brand: 'Airbnb',
  country: 'US',
  email: 'buyer@example.com',
  customerIp: '192.0.2.1',
  providerConsent: { terms: true, privacy: true },
  providerProduct: { brand_name: 'Airbnb', country_code: 'US', denomination: '5 USD' },
  network: 'mainnet',
  recipient: 'u1test',
  paymentMemo: 'zucchini:' + id,
  amountZatoshis: '100000000',
  expiresAt: now + 900,
  settlement: { state: 'buffer_confirmed', bufferReceipt: { amountAtomic: '5500000' } },
});
const config = {
  confirmations: 10,
  bufferAddress: from,
  settlementAsset: SOLANA_USDC.asset,
  settlementNetwork: 'sol',
  solanaMaxFeeLamports: '5000',
  solanaMaxRentLamports: '0',
};
const payment = () => ({
  externalOrderId: id,
  orderId: 'ord-test',
  state: 'WAITING_FOR_PAYMENT',
  coin: 'USDC',
  network: 'Solana',
  recipient: to,
  amountAtomic: '5000000',
  expiresAt: now + 1800,
});
const snapshot = (o) => ({
  version: 1,
  sequence: 1,
  network: 'mainnet',
  observedAt: now,
  tipHeight: 100,
  tipHash: 'a'.repeat(64),
  scannedHeight: 100,
  receipts: [
    {
      txid: 'b'.repeat(64),
      pool: 'orchard',
      outputIndex: 0,
      recipient: o.recipient,
      memo: o.paymentMemo,
      amountZatoshis: o.amountZatoshis,
      blockHeight: 90,
      receivedAt: now - 10,
    },
  ],
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cr-store-')),
    store = createStore(join(dir, 'db'), 'a'.repeat(64));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const o = order();
  o.snapshot = snapshot(o);
  store.insert(o, 'private');
  return store;
}
const account = (owner, amount) => ({
  owner: SOLANA_USDC.program,
  executable: false,
  data: {
    program: 'spl-token',
    parsed: {
      type: 'account',
      info: {
        owner,
        mint: SOLANA_USDC.mint,
        state: 'initialized',
        tokenAmount: { amount, decimals: 6 },
      },
    },
  },
});
async function plan(o) {
  const mint = address(SOLANA_USDC.mint),
    tokenProgram = address(SOLANA_USDC.program);
  const [a] = await findAssociatedTokenPda({ owner: address(from), mint, tokenProgram });
  const [b] = await findAssociatedTokenPda({ owner: address(to), mint, tokenProgram });
  return prepareSolanaUsdcPayment({
    from,
    to,
    amountAtomic: o.providerPayment.amountAtomic,
    sourceAccountInfo: { ...account(from, '5500000'), address: a },
    destinationAccountInfo: { ...account(to, '0'), address: b },
    latestBlockhash: { blockhash: key(9), lastValidBlockHeight: 500 },
    feeLamports: '5000',
    maxFeeLamports: '5000',
    maxRentLamports: '0',
    solBalanceLamports: '10000',
    genesisHash: SOLANA_USDC.genesisHash,
  });
}
const adapters = () => ({
  createOrder: async () => payment(),
  prepareTopup: plan,
  verifyTopup: async () => ({
    confirmed: true,
    canonical: true,
    txid: signature,
    token: SOLANA_USDC.asset,
    network: 'sol',
    from,
    to,
    amountAtomic: '5000000',
  }),
  getOrder: async () => ({
    orderId: 'ord-test',
    externalOrderId: id,
    state: 'COMPLETED',
    delivery: {
      beneficiary: 'buyer@example.com',
      brand: 'Airbnb',
      country: 'US',
      faceAmount: '5.00',
      card: { code: 'SYNTHETIC-CODE' },
    },
  }),
});

test('partner HTTP requests bind idempotency, email and trusted customer IP; no newsletter', async () => {
  const calls = [],
    p = createCryptorefillsProvider(
      { key: 'synthetic-key' },
      {
        fetcher: async (url, opts) => {
          calls.push({ url, opts });
          return new Response('{"order_id":"ord-test"}');
        },
      },
    );
  await p.createOrder(order());
  await p.createOrder(order());
  await p.getOrder('ord-test', '192.0.2.1');
  await p.cancelOrder('ord-test', '192.0.2.1');
  assert.equal(calls[0].url, 'https://api.cryptorefills.com/v6/partner/orders');
  const b = JSON.parse(calls[0].opts.body);
  assert.equal(b.external_order_id, id);
  assert.equal(b.user.email, order().email);
  assert.equal(b.deliveries[0].beneficiary_account, order().email);
  assert.equal(b.user.has_accepted_newsletter, undefined);
  assert.equal(calls[0].opts.headers['X-CR-Forwarded-For'], '192.0.2.1');
  assert.deepEqual(JSON.parse(calls[1].opts.body), b);
  assert.equal(calls[3].opts.method, 'DELETE');
  assert.throws(() => p.getOrder('../wrong', '192.0.2.1'));
  await assert.rejects(p.getOrder('ord-test', 'not-an-ip'));
  assert.throws(() => p.createOrder({ ...order(), providerConsent: {} }));
});
test('provider errors redact upstream text and redirects are rejected', async () => {
  const p = createCryptorefillsProvider(
    { key: 'secret' },
    {
      fetcher: async (_url, opts) => {
        assert.equal(opts.redirect, 'error');
        return new Response('{"code":"KYC_MISSING","detail":"secret buyer@example.com"}', {
          status: 422,
        });
      },
    },
  );
  await assert.rejects(
    p.createOrder(order()),
    (e) =>
      e instanceof CryptorefillsError && e.code === 'KYC_MISSING' && !e.message.includes('secret'),
  );
});
test('Cryptorefills configuration cannot activate checkout', () => {
  assert.throws(
    () => loadConfig({ GIFT_CARD_PROVIDER: 'cryptorefills', CHECKOUT_ENABLED: 'true' }),
    /blocked/,
  );
  assert.equal(loadConfig({ GIFT_CARD_PROVIDER: 'cryptorefills' }).checkoutEnabled, false);
});
test('offline per-order payment works below 0fiat minimum and delivers only matched evidence', async (t) => {
  const store = await fixture(t),
    c = createCryptorefillsSettlement({ store, config, adapters: adapters(), now: () => now });
  await c.act(id, 'prepare_topup');
  assert.equal(store.get(id).settlement.topupPlan.to, to);
  await c.act(id, 'begin_topup');
  await assert.rejects(c.act(id, 'begin_topup'));
  await c.act(id, 'submit_topup', { txid: signature });
  await c.act(id, 'check_topup');
  assert.equal(store.get(id).settlement.state, 'provider_paid');
  assert.equal(store.get(id).state, 'fulfilling');
  await c.act(id, 'check_delivery');
  assert.equal(store.get(id).state, 'delivered');
});
test('ambiguous order response persists attempt and retries same order ID', async (t) => {
  const store = await fixture(t),
    a = adapters();
  let calls = 0;
  a.createOrder = async (o) => {
    assert.equal(o.id, id);
    assert.equal(store.get(id).settlement.state, 'provider_order_requested');
    if (++calls === 1) throw Error('timeout');
    return payment();
  };
  const c = createCryptorefillsSettlement({ store, config, adapters: a, now: () => now });
  await assert.rejects(c.act(id, 'prepare_topup'));
  assert.equal(store.get(id).settlement.state, 'provider_order_requested');
  await c.act(id, 'prepare_topup');
  assert.equal(calls, 2);
});
test('wrong order, price, network, expiry and destination block wallet preparation', async (t) => {
  const store = await fixture(t);
  for (const patch of [
    { externalOrderId: 'wrong' },
    { amountAtomic: '5000001' },
    { network: 'Base' },
    { expiresAt: now },
    { recipient: 'bad' },
  ]) {
    store.update(id, (r) => {
      r.settlement.state = 'buffer_confirmed';
      delete r.providerOrderId;
    });
    const a = adapters();
    a.createOrder = async () => ({ ...payment(), ...patch });
    a.prepareTopup = () => {
      throw Error('Must not build');
    };
    await assert.rejects(
      createCryptorefillsSettlement({ store, config, adapters: a, now: () => now }).act(
        id,
        'prepare_topup',
      ),
    );
    assert.notEqual(store.get(id).settlement.state, 'topup_ready');
  }
});
test('wrong payment evidence and terminal provider failure never deliver', async (t) => {
  const store = await fixture(t),
    a = adapters(),
    c = createCryptorefillsSettlement({ store, config, adapters: a, now: () => now });
  await c.act(id, 'prepare_topup');
  await c.act(id, 'begin_topup');
  await c.act(id, 'submit_topup', { txid: signature });
  a.verifyTopup = async () => ({
    confirmed: true,
    canonical: true,
    txid: signature,
    token: SOLANA_USDC.asset,
    network: 'sol',
    from,
    to: key(8),
    amountAtomic: '5000000',
  });
  await assert.rejects(c.act(id, 'check_topup'));
  assert.equal(store.get(id).state, 'payment_pending');
  a.verifyTopup = adapters().verifyTopup;
  await c.act(id, 'check_topup');
  a.getOrder = async () => ({ ...(await adapters().getOrder()), externalOrderId: 'wrong' });
  await assert.rejects(c.act(id, 'check_delivery'));
  a.getOrder = async () => ({ orderId: 'ord-test', externalOrderId: id, state: 'REFUNDED' });
  await c.act(id, 'check_delivery');
  assert.equal(store.get(id).state, 'refund_review');
  assert.equal(store.get(id).card, undefined);
});

test('checkout requires provider consent/email, separates provider identity and rejects legacy catalogs', async (t) => {
  const { createApp } = await import('../src/application.mjs');
  const { Readable } = await import('node:stream');
  const store = await fixture(t),
    current = Math.floor(Date.now() / 1000);
  const cfg = {
    ...config,
    giftCardProvider: 'cryptorefills',
    fundingMode: 'shielded_buffer',
    network: 'mainnet',
    origin: 'https://store.example',
    adminToken: 'a'.repeat(32),
    checkoutEnabled: true,
    markupBps: 0,
    maxUsd: 200,
    recipient:
      'u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl',
  };
  const catalog = {
    provider: 'cryptorefills',
    fetchedAt: new Date().toISOString(),
    vouchers: [
      {
        voucherId: 2,
        brandName: 'Airbnb',
        name: 'Airbnb',
        countryCode: 'US',
        currency: 'USD',
        denominationMode: 'FIXED',
        denominations: [5],
        minAmount: 5,
        maxAmount: 5,
        providerDenominations: { '5.00': '5 USD' },
      },
    ],
  };
  const app = createApp({
    store,
    config: cfg,
    catalog,
    clock: () => current,
    cryptorefillsAdapters: {},
    provider: {
      quoteProduct: async () => ({
        voucherId: 2,
        faceAmount: '5.00',
        currency: 'USD',
        payableAmount: '5.00',
      }),
    },
    priceFetcher: async () =>
      new Response(JSON.stringify({ zcash: { usd: 50, last_updated_at: current } })),
  });
  async function call(path, data, admin = false) {
    const req = Readable.from([Buffer.from(JSON.stringify(data))]);
    req.url = path;
    req.method = 'POST';
    req.headers = {
      origin: cfg.origin,
      ...(admin ? { authorization: 'Bearer ' + cfg.adminToken } : {}),
    };
    req.socket = { remoteAddress: '192.0.2.1' };
    let status, value;
    await app.handler(req, {
      setHeader() {},
      writeHead(code) {
        status = code;
      },
      end(text) {
        value = JSON.parse(text);
      },
    });
    return { status, value };
  }
  await call(
    '/internal/heartbeat',
    { network: cfg.network, recipient: cfg.recipient, caughtUp: true },
    true,
  );
  const input = {
    voucherId: 2,
    amount: 5,
    email: 'buyer@example.com',
    replyAddress: 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpq6d8g',
    providerTermsAccepted: true,
    providerPrivacyAccepted: true,
  };
  assert.equal(
    (await call('/api/orders', { ...input, providerPrivacyAccepted: false })).status,
    400,
  );
  assert.equal((await call('/api/orders', { ...input, email: '' })).status, 400);
  const result = await call('/api/orders', input);
  assert.equal(result.status, 201);
  const saved = store.get(result.value.order.id);
  assert.equal(saved.giftCardProvider, 'cryptorefills');
  assert.equal(saved.email, input.email);
  assert.equal(saved.emailOptIn, false);
  assert.equal(saved.customerIp, '192.0.2.1');
  assert.equal(saved.providerProduct.denomination, '5 USD');
  assert.equal(result.value.order.email, undefined);
  assert.equal(result.value.order.customerIp, undefined);
  delete catalog.provider;
  assert.equal((await call('/api/orders', input)).status, 503);
});

test('scanner pause during external preparation cannot be overwritten by a payment plan', async (t) => {
  const store = await fixture(t),
    a = adapters();
  a.createOrder = async () => {
    store.update(id, (r) => {
      r.state = 'support_required';
    });
    return payment();
  };
  const c = createCryptorefillsSettlement({ store, config, adapters: a, now: () => now });
  await assert.rejects(c.act(id, 'prepare_topup'), /Order changed/);
  assert.equal(store.get(id).state, 'support_required');
  assert.notEqual(store.get(id).settlement.state, 'topup_ready');
});
