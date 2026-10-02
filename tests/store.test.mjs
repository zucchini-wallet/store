import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { priceOrder, validateFace, reconcile, paymentUri } from '../src/domain.mjs';
import { createStore } from '../src/storage.mjs';
import { createProvider, providerState, ProviderError } from '../src/provider.mjs';
import { createFulfillment } from '../src/fulfillment.mjs';
import { reconcileBatch, snapshotFor } from '../src/collector-state.mjs';
import { loadConfig } from '../src/config.mjs';
const now = 1800000000,
  id = 'merchant-order-1',
  recipient = 'u1-receiver';
const order = () => ({
  id,
  recipient,
  network: 'mainnet',
  amountZatoshis: '100000',
  expiresAt: now + 100,
  state: 'payment_pending',
  voucherId: 123,
  faceAmount: '10.00',
  totalUsd: '10.00',
  costUsd: '9.00',
  brand: 'Test brand',
});
const snapshot = () => ({
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
      recipient,
      memo: 'zucchini:' + id,
      receivedAt: now - 10,
      blockHeight: 90,
      amountZatoshis: '100000',
    },
  ],
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'zucchini-store-'));
  const file = join(dir, 'store.sqlite');
  const key = randomBytes(32).toString('hex'),
    store = createStore(file, key);
  return {
    dir,
    file,
    key,
    store,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test('quotes round up to zatoshis, reject stale prices and bound gift card values', () => {
  const quote = { payableAmount: 9.99, currency: 'USD' };
  const args = { rate: 31, rateAt: now, now, markupBps: 0, maxUsd: 200 };
  assert.equal(priceOrder(quote, args).amountZatoshis, '32225807');
  assert.equal(priceOrder(quote, { ...args, markupBps: 100 }).totalUsd, '10.09');
  assert.throws(() => priceOrder(quote, { ...args, rateAt: now - 121 }));
  assert.throws(() => priceOrder({ ...quote, currency: 'EUR' }, args));
  assert.throws(() => priceOrder(quote, { ...args, maxUsd: 5 }));
  const v = { denominationMode: 'FIXED', denominations: [10, 25], minAmount: 10, maxAmount: 25 };
  assert.equal(validateFace(v, '10'), '10.00');
  assert.throws(() => validateFace(v, '15'));
  assert.equal(validateFace({ ...v, denominationMode: 'FLEXIBLE' }, '15.50'), '15.50');
  assert.throws(() => validateFace(v, '10.001'));
  assert.match(paymentUri(order()), /memo=enVjY2hpbmk6/);
});
test('canonical full receipts authorize exact amount/memo only; txid submission cannot fulfill', () => {
  const o = order(),
    s = snapshot();
  assert.equal(reconcile(o, s, now, 10).canFulfill, true);
  for (const change of [
    (s) => (s.receipts[0].memo = 'different'),
    (s) => (s.receipts[0].recipient = 'another'),
    (s) => (s.scannedHeight = 99),
    (s) => (s.observedAt = now - 121),
    (s) => (s.receipts[0].amountZatoshis = '99999'),
    (s) => (s.receipts[0].amountZatoshis = '100001'),
    (s) => (s.receipts[0].receivedAt = o.expiresAt + 1),
  ]) {
    const copy = structuredClone(s);
    change(copy);
    if (copy.receipts[0].receivedAt > now + 30) copy.observedAt = copy.receipts[0].receivedAt;
    assert.equal(reconcile(o, copy, Math.max(now, copy.observedAt), 10).canFulfill, false);
  }
  assert.equal(reconcile({ ...o, txid: 'b'.repeat(64) }, undefined, now, 10).canFulfill, false);
});
test('order capabilities are hashed; card/email encrypted; durable recovery and exclusive receipt attribution', async () => {
  const f = await fixture();
  try {
    const o = { ...order(), card: { pin: 'SECRET-PIN' }, email: 'private@example.com' };
    f.store.insert(o, 'capability');
    assert.equal(f.store.authorized(id, 'wrong'), undefined);
    assert.equal(f.store.authorized(id, 'capability').card.pin, 'SECRET-PIN');
    assert.ok(!(await readFile(f.file)).includes(Buffer.from('private@example.com')));
    assert.ok(!(await readFile(f.file)).includes(Buffer.from('SECRET-PIN')));
    f.store.update(id, (o) => (o.state = 'fulfilling'));
    assert.equal(f.store.get(id).state, 'fulfilling');
    f.store.claimReceipts(id, snapshot().receipts);
    assert.throws(() => f.store.claimReceipts('other', snapshot().receipts));
    const second = createStore(f.file, f.key);
    assert.equal(second.get(id).state, 'fulfilling');
    second.close();
    assert.throws(() =>
      f.store.update(id, (o) => {
        o.state = 'delivered';
        throw Error('rollback');
      }),
    );
    assert.equal(f.store.get(id).state, 'fulfilling');
  } finally {
    await f.cleanup();
  }
});
test('0fiat signatures cover the exact immutable request; documented status mapping', async () => {
  let request;
  const p = createProvider(
    { API_KEY: 'test', API_SECRET: 'secret' },
    {
      now: () => 123,
      fetcher: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ data: { status: 6 } }), { status: 200 });
      },
    },
  );
  await p.request('/orders', { clientOrderId: 'same-id', amount: 10 });
  assert.equal(
    JSON.parse(Buffer.from(request.options.headers['x-0fiat-payload'], 'base64')).body
      .clientOrderId,
    'same-id',
  );
  assert.equal(JSON.parse(request.options.body).clientOrderId, 'same-id');
  assert.equal(request.options.headers['x-0fiat-signature'].length, 128);
  assert.equal(providerState({ status: 6 }), 'succeeded');
  assert.equal(providerState({ status: -6 }), 'refunded');
  assert.throws(() => providerState({ status: 999 }));
});
test('fulfillment recovers unknown response with the same provider id and never double-purchases', async () => {
  const f = await fixture();
  try {
    const o = order();
    o.snapshot = snapshot();
    f.store.insert(o, 'token');
    let purchases = 0,
      existing = false,
      ids = [];
    const provider = {
      async request(path, body) {
        if (path.startsWith('/quote'))
          return { voucherId: 123, faceAmount: 10, payableAmount: 9, currency: 'USD' };
        if (path.startsWith('/clientOrderIdStatus')) {
          if (!existing) throw new ProviderError(404);
          return { status: 6, giftCardDetails: { code: 'REAL-MOCK-CARD' } };
        }
        if (path === '/orders') {
          purchases++;
          ids.push(body.clientOrderId);
          existing = true;
          throw Error('Connection lost after provider accepted');
        }
      },
    };
    const service = createFulfillment({
      store: f.store,
      provider,
      config: {
        confirmations: 10,
        fulfillmentEnabled: true,
        fulfillmentEmail: 'operator@example.com',
      },
      now: () => now,
    });
    await assert.rejects(service.process(f.store.get(id)));
    assert.equal(f.store.get(id).state, 'fulfilling');
    await service.process(f.store.get(id));
    assert.equal(f.store.get(id).state, 'delivered');
    await service.process(f.store.get(id));
    assert.equal(purchases, 1);
    assert.deepEqual(ids, [id]);
  } finally {
    await f.cleanup();
  }
});
test('failed provider creates refund review; stale or reorganized receipt cannot create a purchase', async () => {
  const f = await fixture();
  try {
    const o = order();
    o.snapshot = snapshot();
    f.store.insert(o, 'token');
    let creates = 0;
    const provider = {
      async request(path) {
        if (path.startsWith('/quote'))
          return { voucherId: 123, faceAmount: 10, payableAmount: 9, currency: 'USD' };
        if (path.startsWith('/clientOrderIdStatus')) throw new ProviderError(404);
        creates++;
        return { status: -2 };
      },
    };
    const service = createFulfillment({
      store: f.store,
      provider,
      config: {
        confirmations: 10,
        fulfillmentEnabled: true,
        fulfillmentEmail: 'operator@example.com',
      },
      now: () => now,
    });
    await service.process(f.store.get(id));
    assert.equal(f.store.get(id).state, 'refund_review');
    assert.equal(creates, 1);
    f.store.update(id, (o) => {
      o.state = 'fulfilling';
      o.snapshot.observedAt = now - 200;
    });
    await service.process(f.store.get(id));
    assert.equal(creates, 1);
  } finally {
    await f.cleanup();
  }
});
test('email is opt-in, uses persistent idempotency and stops retries before deduplication expires', async () => {
  const f = await fixture();
  try {
    f.store.insert(
      {
        ...order(),
        state: 'delivered',
        card: { code: 'code' },
        email: 'buyer@example.com',
        emailOptIn: false,
      },
      'token',
    );
    let sent = [];
    const service = createFulfillment({
      store: f.store,
      provider: {},
      config: { resendKey: 'fake', emailFrom: 'operator@example.com' },
      now: () => now,
      fetcher: async (url, request) => {
        sent.push(request);
        return new Response('{}', { status: 200 });
      },
    });
    await service.process(f.store.get(id));
    assert.equal(sent.length, 0);
    f.store.update(id, (o) => (o.emailOptIn = true));
    await service.process(f.store.get(id));
    await service.process(f.store.get(id));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers['Idempotency-Key'], 'gift-card/' + id);
    f.store.update(id, (o) => {
      o.emailSent = false;
      o.emailStartedAt = now - 24 * 3600;
    });
    await service.process(f.store.get(id));
    assert.equal(sent.length, 1);
    assert.equal(f.store.get(id).emailNeedsReview, true);
  } finally {
    await f.cleanup();
  }
});
test('collector preserves first-seen time and drops noncanonical blocks on reorg', () => {
  const r = snapshot().receipts[0];
  const initial = {
    network: 'mainnet',
    blocks: [{ height: 89, hash: 'c'.repeat(64), receipts: [] }],
    seen: {},
    scannedHeight: 89,
  };
  const b = {
    network: 'mainnet',
    anchorHash: 'c'.repeat(64),
    tipHeight: 90,
    tipHash: 'd'.repeat(64),
    blocks: [{ height: 90, hash: 'd'.repeat(64), previousHash: 'c'.repeat(64), receipts: [r] }],
  };
  const first = reconcileBatch(initial, b, 89, now),
    again = reconcileBatch(first, b, 89, now + 5);
  assert.equal(Object.values(again.seen)[0], now);
  assert.equal(snapshotFor({ ...again, sequence: 2 }, order()).receipts[0].receivedAt, now);
  const changed = reconcileBatch(first, { ...b, anchorHash: 'e'.repeat(64) }, 89, now + 5);
  assert.equal(changed.caughtUp, false);
  assert.equal(changed.blocks.length, 0);
});
test('live checkout refuses incomplete deployment configuration', () => {
  assert.throws(() =>
    loadConfig({ CHECKOUT_ENABLED: 'true', PUBLIC_ORIGIN: 'https://store.zucchinifi.xyz' }),
  );
  assert.equal(loadConfig({}).checkoutEnabled, false);
});
