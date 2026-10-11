import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from '../src/application.mjs';
import { SOLANA_USDC } from '../src/solana-settlement.mjs';
import { fixture, start, refundAddress } from './fixtures/direct-contract.mjs';
async function httpFixture(t) {
  const f = await fixture(t, { insertDraft: false });
  const config = {
    ...f.config,
    origin: 'https://store.example',
    fundingMode: 'direct_swap',
    giftCardProvider: 'cryptorefills',
    network: 'mainnet',
    adminToken: 'a'.repeat(32),
  };
  const product = {
    id: 'cryptorefills:US:20000000-0000-4000-8000-000000000000',
    providerProductId: '20000000-0000-4000-8000-000000000000',
    provider: 'cryptorefills',
    name: 'Airbnb',
    brandName: 'Airbnb',
    countryCode: 'US',
    currency: 'USD',
    denominationMode: 'FIXED',
    denominations: ['5'],
    minAmount: '5',
    maxAmount: '5',
    providerDenomination: '5 USD',
  };
  f.app = createApp({
    config,
    store: f.store,
    clock: () => f.time,
    directAdapters: f.adapters,
    runtimeReadiness: { checkoutActivatable: true },
    catalog: {
      provider: 'cryptorefills',
      fetchedAt: new Date().toISOString(),
      vouchers: [product],
    },
    // Synthetic reviewed price only; production has no such mapping and remains blocked.
    provider: {
      quoteProduct: async () => ({
        providerProductId: product.providerProductId,
        faceAmount: '5.00',
        brand: 'Airbnb',
        country: 'US',
        amountAtomic: '5000000',
        coin: 'USDC',
        network: 'Solana',
        mint: SOLANA_USDC.mint,
        networkVerified: true,
        identityRequirementsVerified: true,
        checkoutEligible: true,
      }),
    },
    priceFetcher: () => assert.fail('Direct route must not use a CoinGecko merchant quote'),
  });
  f.call = async (path, method = 'GET', body, token) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, {
      url: path,
      method,
      headers: { origin: config.origin, ...(token ? { authorization: 'Bearer ' + token } : {}) },
      socket: { remoteAddress: '192.0.2.1' },
    });
    let status, data;
    await f.app.handler(req, {
      setHeader() {},
      writeHead(code) {
        status = code;
      },
      end(value) {
        data = JSON.parse(value);
      },
    });
    return { status, data };
  };
  f.input = {
    id: product.id,
    amount: '5',
    email: 'buyer@example.com',
    providerTermsAccepted: true,
    providerPrivacyAccepted: true,
    refundAddress,
    maxInputZatoshis: '13000000',
  };
  return f;
}
test('direct HTTP flow requires separate exact-quote review and does not accept browser txid as payment', async (t) => {
  const f = await httpFixture(t);
  const created = await f.call('/api/orders', 'POST', f.input);
  assert.equal(created.status, 201);
  const { order: draft, token } = created.data;
  assert.equal(draft.directState, 'draft');
  assert.equal(draft.paymentUri, undefined);
  assert.equal(f.calls.length, 0);
  const path = '/api/orders/' + draft.id;
  assert.equal((await f.call(path)).status, 404);
  const prepared = await f.call(path + '/pay', 'POST', {}, token);
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.order.directState, 'quote_ready');
  assert.equal(prepared.data.order.amountZatoshis, '12345678');
  assert.equal(prepared.data.order.paymentUri, undefined);
  assert.equal(f.calls.filter((c) => c[0] === 'createInvoice').length, 1);
  const armed = await f.call(path + '/pay', 'POST', {}, token);
  assert.equal(armed.data.order.directState, 'payment_requested');
  assert.match(armed.data.order.paymentUri, /amount=0\.12345678$/);
  assert.equal(new URL(armed.data.order.paymentUri).searchParams.has('memo'), false);
  assert.equal(armed.data.order.paymentApprovalExpiresAt, start + 480);
  assert.equal((await f.call(path + '/pay', 'POST', {}, token)).status, 409);
  assert.equal((await f.call(path + '/cancel', 'POST', {}, token)).status, 409);
  const submitted = await f.call(path + '/submitted', 'POST', { txid: 'ab'.repeat(32) }, token);
  assert.equal(submitted.data.order.state, 'payment_pending');
  await f.app.tick();
  const completed = await f.call(path, 'GET', undefined, token);
  assert.equal(completed.data.order.state, 'delivered');
  assert.equal(completed.data.order.card.code, 'synthetic-card');
  assert.equal(completed.data.order.paymentUri, undefined);
  assert.equal(
    (await f.call(path + '/refund', 'POST', { address: refundAddress }, token)).status,
    409,
  );
});
test('direct HTTP validates actual consent, namespaced UUID, caps and refunds before any order POST', async (t) => {
  const f = await httpFixture(t);
  for (const changed of [
    { providerTermsAccepted: false },
    { providerPrivacyAccepted: false },
    { email: '' },
    { id: undefined, voucherId: 1 },
    { maxInputZatoshis: undefined },
    { maxInputZatoshis: '0' },
    { maxInputZatoshis: '2100000000000001' },
    { refundAddress: 't1invalid' },
  ])
    assert.equal((await f.call('/api/orders', 'POST', { ...f.input, ...changed })).status, 400);
  assert.equal(f.store.all().length, 0);
  assert.equal(f.calls.length, 0);
});
