import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectGatewayAdapter } from '../src/direct-gateway-adapter.mjs';
import { SOLANA_USDC } from '../src/solana-settlement.mjs';
const input = {
  clientRequestId: '00000000-0000-4000-8000-000000000001',
  amountAtomic: '5000000',
  recipientAddress: 'provider-owner',
  refundAddress: 'customer-refund',
  deadlineEpochSeconds: 1800000900,
};
const quote = () => ({
  provider: 'near_one_click',
  mode: 'execution',
  integrity: 'provider_signature_verified',
  swapType: 'EXACT_OUTPUT',
  originAsset: 'nep141:zec.omft.near',
  destinationAsset: SOLANA_USDC.asset,
  orderId: 'gateway-id',
  providerQuoteId: 'provider-id',
  providerSignature: 'signature',
  request: {
    ...input,
    mode: 'execution',
    swapType: 'EXACT_OUTPUT',
    slippageBps: 100,
    originAssetId: 'nep141:zec.omft.near',
    destinationAssetId: SOLANA_USDC.asset,
  },
  quote: {
    amountInAtomic: '1000000',
    minimumAmountInAtomic: '990000',
    amountOutAtomic: '5000000',
    minimumAmountOutAtomic: '5000000',
    deposit: { address: 'deposit', memo: null, deadline: new Date(1800000600123).toISOString() },
  },
});
function mock(result = quote(), status = 200) {
  const calls = [],
    session = {
      token: async () => 'synthetic-private-token',
      invalidate() {
        this.invalidated = true;
      },
    };
  const adapter = createDirectGatewayAdapter({
    origin: 'https://gateway.example',
    session,
    fetcher: async (url, options) => {
      calls.push({ path: url.pathname, body: JSON.parse(options.body) });
      return Response.json(result, { status });
    },
  });
  return { adapter, calls, session };
}
test('direct gateway binds exact output and restores only the original authenticated request', async () => {
  const m = mock();
  const result = await m.adapter.quoteSwap({}, input);
  assert.equal(result.amountOutAtomic, input.amountAtomic);
  assert.equal(result.minimumInputAtomic, '990000');
  assert.equal(result.deadline, 1800000600);
  assert.equal(result.depositMemo, null);
  assert.deepEqual(m.calls[0].body, quote().request);
  const recovered = mock({
    clientRequestId: input.clientRequestId,
    state: 'created',
    quote: quote(),
  });
  assert.deepEqual(await recovered.adapter.recoverSwap({}, input), result);
  assert.equal(recovered.calls[0].path, '/v1/swaps/quotes/recover');
});
test('direct gateway rejects changed quote context and recovery states without creating a replacement', async () => {
  for (const mutate of [
    (q) => {
      q.request.refundAddress = 'other';
    },
    (q) => {
      q.request.amountAtomic = '6000000';
    },
    (q) => {
      q.request.clientRequestId = 'other';
    },
    (q) => {
      q.request.deadlineEpochSeconds++;
    },
    (q) => {
      q.quote.minimumAmountOutAtomic = '4999999';
    },
    (q) => {
      q.quote.deposit.deadline = new Date(1800000901000).toISOString();
    },
  ]) {
    const q = quote();
    mutate(q);
    await assert.rejects(mock(q).adapter.quoteSwap({}, input));
  }
  for (const state of ['pending', 'not_found']) {
    const m = mock({ clientRequestId: input.clientRequestId, state, quote: null });
    await assert.rejects(m.adapter.recoverSwap({}, input), /no replacement/);
    assert.equal(m.calls.length, 1);
  }
  const m = mock({}, 401);
  await assert.rejects(m.adapter.quoteSwap({}, input));
  assert.equal(m.session.invalidated, true);
  assert.equal(m.calls.length, 1);
});
