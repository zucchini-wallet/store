import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/storage.mjs';
import { createApp } from '../src/application.mjs';
import { createFulfillment } from '../src/fulfillment.mjs';
test('full HTTP checkout: separate connect/pay, private recovery, canonical receipt, fulfillment and idempotence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zucchini-store-http-')),
    store = createStore(join(dir, 'db.sqlite'), 'a'.repeat(64));
  let clock = Math.floor(Date.now() / 1000),
    creates = 0;
  const config = {
    origin: 'https://store.zucchinifi.xyz',
    network: 'mainnet',
    recipient: 'u1-test-fixture',
    checkoutEnabled: true,
    adminToken: 'admin-token'.repeat(5),
    confirmations: 10,
    markupBps: 0,
    maxUsd: 200,
    fulfillmentEnabled: true,
    fulfillmentEmail: 'operator@example.com',
  };
  const catalog = {
    fetchedAt: new Date().toISOString(),
    vouchers: [
      {
        voucherId: 123,
        name: 'Example Gift Card',
        brandName: 'Example',
        iconUrl: 'https://0fiat.com/test.png',
        countryCode: 'US',
        currency: 'USD',
        denominationMode: 'FIXED',
        denominations: [10],
        minAmount: '10',
        maxAmount: '10',
      },
    ],
  };
  const provider = {
    async request(path, body) {
      if (path === '/balance') return { balance: 100, currency: 'USD' };
      if (path.startsWith('/quote'))
        return { voucherId: 123, faceAmount: 10, payableAmount: 9, currency: 'USD' };
      if (path.startsWith('/clientOrderIdStatus')) {
        const { ProviderError } = await import('../src/provider.mjs');
        throw new ProviderError(404);
      }
      if (path === '/orders') {
        creates++;
        return {
          status: 6,
          clientOrderId: body.clientOrderId,
          giftCardDetails: { code: 'mock-code' },
        };
      }
      throw Error('Unexpected request');
    },
  };
  const app = createApp({
      config,
      store,
      provider,
      catalog,
      clock: () => clock,
      priceFetcher: async () =>
        new Response(JSON.stringify({ zcash: { usd: 100, last_updated_at: clock } })),
    }),
    server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, { body, token, origin = config.origin } = {}) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await call('/internal/orders')).status, 401);
    assert.equal((await call('/api/orders', { body: { voucherId: 123, amount: 10 } })).status, 503);
    await call('/internal/heartbeat', {
      body: { network: 'mainnet', recipient: config.recipient, caughtUp: true },
      token: config.adminToken,
    });
    assert.equal(
      (
        await call('/api/orders', {
          body: { voucherId: 123, amount: 10 },
          origin: 'https://evil.example',
        })
      ).status,
      403,
    );
    const {
      data: { order, token },
      status,
    } = await call('/api/orders', { body: { voucherId: 123, amount: 10, emailOptIn: false } });
    assert.equal(status, 201);
    assert.equal(order.state, 'quoted');
    assert.equal(order.paymentUri, undefined);
    assert.equal(order.amountZatoshis, '9000000');
    assert.equal((await call('/api/orders/' + order.id)).status, 404);
    assert.equal((await call('/api/orders/' + order.id, { token: 'wrong' })).status, 404);
    const paid = await call(`/api/orders/${order.id}/pay`, { body: {}, token });
    assert.equal(paid.data.order.state, 'payment_pending');
    assert.match(paid.data.order.paymentUri, /zcash:u1-test-fixture/);
    assert.equal((await call(`/api/orders/${order.id}/cancel`, { body: {}, token })).status, 409);
    const service = createFulfillment({ store, provider, config, now: () => clock });
    await service.process(store.get(order.id));
    assert.equal(creates, 0);
    await call(`/api/orders/${order.id}/submitted`, { body: { txid: 'b'.repeat(64) }, token });
    await service.process(store.get(order.id));
    assert.equal(creates, 0);
    const snapshot = {
      version: 1,
      sequence: 1,
      network: 'mainnet',
      observedAt: clock,
      tipHeight: 100,
      tipHash: 'a'.repeat(64),
      scannedHeight: 100,
      receipts: [
        {
          txid: 'b'.repeat(64),
          pool: 'orchard',
          outputIndex: 0,
          recipient: config.recipient,
          memo: 'zucchini:' + order.id,
          amountZatoshis: order.amountZatoshis,
          receivedAt: clock,
          blockHeight: 90,
        },
      ],
    };
    assert.equal(
      (
        await call('/internal/receipt', {
          body: { orderId: order.id, snapshot },
          token: config.adminToken,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call('/internal/receipt', {
          body: { orderId: order.id, snapshot },
          token: config.adminToken,
        })
      ).status,
      400,
    );
    await service.process(store.get(order.id));
    await service.process(store.get(order.id));
    assert.equal(creates, 1);
    const delivered = await call('/api/orders/' + order.id, { token });
    assert.equal(delivered.data.order.state, 'delivered');
    assert.equal(delivered.data.order.card.code, 'mock-code');
    assert.equal(delivered.data.order.email, undefined);
    clock += 121;
    assert.equal((await call('/api/config')).data.checkoutReady, false);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
