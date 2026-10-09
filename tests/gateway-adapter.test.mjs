import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayAdapter } from '../src/gateway-adapter.mjs';

const config = {
  settlementAsset: 'native-usdc-asset',
  bufferAddress: 'approved-buffer',
  conversionRefundAddress: 'approved-refund',
};
function fixture(deadline) {
  return {
    mode: 'execution',
    integrity: 'provider_signature_verified',
    orderId: 'persisted-gateway-order',
    originAsset: 'nep141:zec.omft.near',
    destinationAsset: config.settlementAsset,
    quote: {
      amountInAtomic: '10000000',
      minimumAmountOutAtomic: '1000000',
      deposit: { address: 'authorized-deposit', deadline },
    },
  };
}
function adapter(deadline) {
  let calls = 0;
  const client = createGatewayAdapter({
    origin: 'https://gateway.example',
    session: async () => 's'.repeat(32),
    config,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url.href, 'https://gateway.example/v1/swaps/quotes');
      const request = JSON.parse(options.body);
      assert.equal(request.mode, 'execution');
      assert.equal(request.recipientAddress, config.bufferAddress);
      assert.equal(request.refundAddress, config.conversionRefundAddress);
      return Response.json(fixture(deadline));
    },
  });
  return { client, calls: () => calls };
}

test('gateway RFC3339 fractional deadlines become conservative integer Unix seconds', async () => {
  const exactSecond = Date.parse('2026-10-09T05:00:00Z') / 1000;
  for (const deadline of [
    '2026-10-09T05:00:00.001Z',
    '2026-10-09T05:00:00.999Z',
    '2026-10-09T05:00:00.999999999Z',
    '2026-10-09T05:00:00Z',
    '2026-10-09T10:30:00.456+05:30',
  ]) {
    const { client, calls } = adapter(deadline);
    const quote = await client.quote({ amountZatoshis: '10000000' });
    assert.equal(quote.deadline, exactSecond);
    assert.equal(Number.isSafeInteger(quote.deadline), true);
    assert.ok(quote.deadline * 1000 <= Date.parse(deadline));
    assert.equal(quote.orderId, 'persisted-gateway-order');
    assert.equal(quote.depositAddress, 'authorized-deposit');
    assert.equal(calls(), 1);
  }
});

test('missing, invalid or timezone-ambiguous gateway deadlines fail without a new quote attempt', async () => {
  for (const deadline of [
    undefined,
    null,
    1791522000,
    '',
    'not-a-date',
    '2026-10-09T05:00:00',
    '2026-10-09',
    '2026-10-09T25:00:00Z',
    '1969-12-31T23:59:59.999Z',
    '1970-01-01T00:00:00.999Z',
  ]) {
    const { client, calls } = adapter(deadline);
    await assert.rejects(
      client.quote({ amountZatoshis: '10000000' }),
      /Invalid gateway quote deadline/,
    );
    assert.equal(calls(), 1);
  }
});
