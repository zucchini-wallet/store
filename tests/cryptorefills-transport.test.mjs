import test from 'node:test';
import assert from 'node:assert/strict';
import { createCryptorefillsProvider, CryptorefillsError } from '../src/cryptorefills-provider.mjs';

const order = {
  id: 'external-synthetic',
  email: 'buyer@example.com',
  customerIp: '192.0.2.1',
  providerConsent: { terms: true, privacy: true },
  providerProduct: { brand_name: 'Steam', country_code: 'US', denomination: '5 USD' },
};

test('401 failover keeps identical idempotency/customer inputs and uses backup on later requests', async () => {
  const calls = [];
  const client = createCryptorefillsProvider(
    { key: 'primary-test', backupKey: 'backup-test' },
    {
      fetcher: async (_url, opts) => {
        calls.push(opts);
        return calls.length === 1
          ? new Response('{"detail":"do not expose credentials"}', { status: 401 })
          : Response.json({ order_id: 'order-synthetic' });
      },
    },
  );
  await client.createOrder(order);
  await client.getOrder('order-synthetic', order.customerIp);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers['X-CR-Partner-Key'], 'primary-test');
  assert.equal(calls[1].headers['X-CR-Partner-Key'], 'backup-test');
  assert.equal(calls[2].headers['X-CR-Partner-Key'], 'backup-test');
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['X-CR-Forwarded-For'], calls[1].headers['X-CR-Forwarded-For']);
  assert.equal(JSON.parse(calls[1].body).external_order_id, order.id);
});

test('ambiguous network errors and non-auth failures never trigger order replays', async () => {
  for (const result of ['timeout', 422, 500]) {
    let calls = 0;
    const client = createCryptorefillsProvider(
      { key: 'primary-test', backupKey: 'backup-test' },
      {
        fetcher: async () => {
          calls++;
          if (result === 'timeout') throw Error('Synthetic network timeout');
          return Response.json(
            { code: 'KYC_MISSING', detail: 'private buyer' },
            { status: result },
          );
        },
      },
    );
    await assert.rejects(client.createOrder(order));
    assert.equal(calls, 1);
  }
});

test('two rejected keys stop after one bounded failover', async () => {
  let calls = 0;
  const client = createCryptorefillsProvider(
    { key: 'primary-test', backupKey: 'backup-test' },
    {
      fetcher: async () => {
        calls++;
        return Response.json({ code: 'invalid_key', detail: 'private details' }, { status: 401 });
      },
    },
  );
  await assert.rejects(
    client.createOrder(order),
    (error) =>
      error instanceof CryptorefillsError &&
      error.status === 401 &&
      !error.message.includes('private'),
  );
  assert.equal(calls, 2);
});

test('429 cooldown prevents a polling or order retry loop without sleeping or sending more calls', async () => {
  let calls = 0;
  const client = createCryptorefillsProvider(
    { key: 'primary-test' },
    {
      fetcher: async () => {
        calls++;
        return Response.json(
          { code: 'partner_daily_order_velocity_exceeded' },
          {
            status: 429,
            headers: { 'Retry-After': '120' },
          },
        );
      },
    },
  );
  await assert.rejects(
    client.createOrder(order),
    (error) => error.status === 429 && error.retryAfterSeconds === 120,
  );
  await assert.rejects(
    client.getOrder('order-synthetic', order.customerIp),
    (error) => error.status === 429 && error.retryAfterSeconds > 0,
  );
  assert.equal(calls, 1);
});

test('missing or duplicate backup keys cannot masquerade as redundancy', () => {
  for (const backupKey of ['', 'primary-test', 3])
    assert.throws(() => createCryptorefillsProvider({ key: 'primary-test', backupKey }));
});

test('HTTP status survives non-JSON failures and oversized responses cannot trigger replay', async () => {
  for (const [body, status, expected] of [
    ['<html>unavailable private details</html>', 429, 429],
    ['x'.repeat(1000001), 200, 502],
  ]) {
    let calls = 0;
    const client = createCryptorefillsProvider(
      { key: 'primary-test', backupKey: 'backup-test' },
      {
        fetcher: async () => {
          calls++;
          return new Response(body, { status });
        },
      },
    );
    await assert.rejects(
      client.createOrder(order),
      (error) =>
        error instanceof CryptorefillsError &&
        error.status === expected &&
        !error.message.includes('private'),
    );
    assert.equal(calls, 1);
  }
});
