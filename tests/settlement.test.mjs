import { base58 } from '@scure/base';
import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  SOLANA_USDC,
  prepareSolanaUsdcTopup,
  verifySolanaTransferEvidence,
} from '../src/solana-settlement.mjs';
import { createOperatorSolana } from '../public/operator-solana.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/storage.mjs';
import {
  createPaymentMemo,
  parsePaymentMemo,
  validateShieldedAddress,
} from '../src/payment-memo.mjs';
import { reconcile, paymentUri } from '../src/domain.mjs';
import { snapshotFor } from '../src/collector-state.mjs';
import { createSettlement } from '../src/settlement.mjs';
import { createFulfillment } from '../src/fulfillment.mjs';
import { ProviderError } from '../src/provider.mjs';
import { createEvmEvidence } from '../src/evm-evidence.mjs';
import { createApp } from '../src/application.mjs';
import { createGatewayAdapter } from '../src/gateway-adapter.mjs';
// Public vectors from zcash_address 0.13.0 encoding.rs (Sapling zero receiver and its UA).
const reply = 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpq6d8g';
const ua =
  'u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl';
const id = '00000000-0000-4000-8000-000000000001',
  now = 1800000000;
const token = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const buffer = '0x' + 'a'.repeat(40),
  deposit = '0x' + 'b'.repeat(40);
const config = {
  origin: 'https://store.example',
  confirmations: 10,
  fulfillmentEnabled: true,
  settlementAsset: token,
  settlementNetwork: 'base',
  bufferAddress: buffer,
  providerDepositAddress: deposit,
  conversionRefundAddress: 't1' + 'A'.repeat(33),
  replyAmountZatoshis: '1000',
};
const order = () => ({
  id,
  network: 'mainnet',
  recipient: ua,
  replyAddress: reply,
  paymentMemo: createPaymentMemo(id, reply, 'mainnet'),
  amountZatoshis: '100000000',
  expiresAt: now + 900,
  state: 'payment_pending',
  fundingMode: 'shielded_buffer',
  costUsd: '10.00',
  totalUsd: '10.50',
  voucherId: 1,
  faceAmount: '10.00',
  recoveryToken: 'k'.repeat(43),
  settlement: { state: 'awaiting_receipt' },
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
  const dir = await mkdtemp(join(tmpdir(), 'store-settlement-'));
  const store = createStore(join(dir, 'db'), 'a'.repeat(64));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const o = order();
  o.snapshot = snapshot(o);
  store.insert(o, 'k'.repeat(43));
  return store;
}
function adapters() {
  return {
    quote: async (o) => ({
      orderId: 'gateway-1',
      originAsset: 'nep141:zec.omft.near',
      destinationAsset: token,
      recipientAddress: buffer,
      refundAddress: config.conversionRefundAddress,
      amountInAtomic: o.amountZatoshis,
      minimumOutputAtomic: '10500000',
      deadline: now + 600,
      signatureVerified: true,
      depositAddress: config.conversionRefundAddress,
      memo: null,
    }),
    conversionStatus: async () => ({
      orderId: 'gateway-1',
      status: 'SUCCESS',
      originTransactions: [{ hash: 'd'.repeat(64) }],
      destinationTransactions: [{ hash: '0x' + 'c'.repeat(64) }],
    }),
    verifyBufferReceipt: async () => ({
      canonical: true,
      confirmed: true,
      token,
      network: 'base',
      recipient: buffer,
      amountAtomic: '10500000',
      txid: '0x' + 'c'.repeat(64),
      logIndex: '0x0',
    }),
    prepareTopup: async () => ({
      token,
      network: 'base',
      from: buffer,
      to: deposit,
      amountAtomic: '10000000',
    }),
    verifyTopup: async (_o, s) => ({
      ...s.topupPlan,
      canonical: true,
      confirmed: true,
      txid: s.topupTxid,
    }),
    verifyProviderCredit: async (_o, s) => ({
      id: 'ledger-1',
      type: 'TOPUP',
      currency: 'USD',
      txid: s.topupTxid,
      amountUsd: '10.00',
    }),
    verifyReply: async (o, s) => ({
      ...s.replyPlan,
      txid: s.replyTxid,
      canonical: true,
      confirmed: true,
    }),
  };
}
test('shielded address vectors, malformed JSON, network and immutable memo matching', () => {
  assert.equal(validateShieldedAddress(reply, 'mainnet'), reply);
  assert.equal(validateShieldedAddress(ua, 'mainnet'), ua);
  for (const value of ['u1fake', reply.slice(0, -1) + 'q', config.conversionRefundAddress])
    assert.throws(() => validateShieldedAddress(value, 'mainnet'));
  assert.throws(() => validateShieldedAddress(ua, 'testnet'));
  assert.throws(() => parsePaymentMemo('{', 'mainnet'));
  assert.throws(() =>
    parsePaymentMemo(JSON.stringify({ v: 1, order: id, reply, extra: 1 }), 'mainnet'),
  );
  const o = order(),
    snap = snapshot(o);
  assert.equal(reconcile(o, snap, now, 10).canFulfill, true);
  for (const memo of [
    'zucchini:' + id,
    createPaymentMemo(id, ua, 'mainnet'),
    createPaymentMemo('00000000-0000-4000-8000-000000000002', reply, 'mainnet'),
  ])
    assert.equal(
      reconcile(o, { ...snap, receipts: [{ ...snap.receipts[0], memo }] }, now, 10).canFulfill,
      false,
    );
  assert.equal(parsePaymentMemo('zucchini:old-order', 'mainnet').version, 0);
  assert.equal(
    reconcile(o, { ...snap, receipts: [{ ...snap.receipts[0], amountZatoshis: '1' }] }, now, 10)
      .state,
    'underpaid',
  );
  assert.equal(
    reconcile(o, { ...snap, receipts: [{ ...snap.receipts[0], blockHeight: null }] }, now, 10)
      .canFulfill,
    false,
  );
  assert.equal(reconcile(o, { ...snap, observedAt: now - 121 }, now, 10).canFulfill, false);
  assert.equal(
    reconcile(o, { ...snap, receipts: [...snap.receipts, ...snap.receipts] }, now, 10)
      .receivedZatoshis,
    o.amountZatoshis,
  );
  const state = {
    sequence: 1,
    network: 'mainnet',
    observedAt: now,
    tipHeight: 100,
    tipHash: 'a'.repeat(64),
    scannedHeight: 100,
    blocks: [{ receipts: snap.receipts }],
    seen: { [snap.receipts[0].txid + '/orchard/0']: now - 10 },
  };
  assert.equal(snapshotFor(state, o).receipts.length, 1);
  const uri = paymentUri(o);
  assert.equal(
    Buffer.from(new URLSearchParams(uri.split('?')[1]).get('memo'), 'base64url').toString(),
    o.paymentMemo,
  );
});
test('durable approved flow: conversion, buffer, topup credit, purchase, private reply', async (t) => {
  const store = await fixture(t);
  const service = createSettlement({ store, config, adapters: adapters(), now: () => now });
  let creates = 0;
  const provider = {
    request: async (path, body) => {
      if (path.startsWith('/quote'))
        return { currency: 'USD', voucherId: 1, faceAmount: 10, payableAmount: 10 };
      if (path.startsWith('/clientOrderIdStatus')) throw new ProviderError(404);
      if (path === '/orders') {
        creates++;
        assert.equal(body.clientOrderId, id);
        return { status: 6, giftCardDetails: { code: 'fixture-only' } };
      }
      throw Error('unexpected');
    },
  };
  const fulfillment = createFulfillment({ store, config, provider, now: () => now });
  await fulfillment.process(store.get(id));
  assert.equal(creates, 0);
  for (const action of ['prepare_conversion', 'begin_conversion']) await service.act(id, action);
  await assert.rejects(service.act(id, 'begin_conversion'));
  await service.act(id, 'submit_conversion', { txid: 'd'.repeat(64) });
  await assert.rejects(service.act(id, 'submit_conversion', { txid: 'e'.repeat(64) }));
  await service.act(id, 'check_conversion');
  await service.act(id, 'prepare_topup');
  await service.act(id, 'begin_topup');
  await service.act(id, 'submit_topup', { txid: '0x' + 'e'.repeat(64) });
  await service.act(id, 'check_topup');
  await fulfillment.process(store.get(id));
  await fulfillment.process(store.get(id));
  assert.equal(creates, 1);
  assert.equal(store.authorized(id, 'k'.repeat(43)).state, 'delivered');
  assert.equal(store.authorized(id, 'wrong'), undefined);
  await service.act(id, 'prepare_reply');
  const memo = store.get(id).settlement.replyPlan.memo;
  assert.ok(memo.includes('#order=' + id));
  await service.act(id, 'begin_reply');
  await assert.rejects(service.act(id, 'prepare_reply'));
  await service.act(id, 'submit_reply', { txid: 'f'.repeat(64) });
  await service.act(id, 'check_reply');
  assert.equal(store.get(id).settlement.state, 'reply_confirmed');
});
test('ambiguous quotes, expiry, insufficient output, unmatched credit and reorg fail closed', async (t) => {
  const store = await fixture(t);
  const a = adapters();
  let calls = 0;
  a.quote = async () => {
    calls++;
    throw Error('timeout');
  };
  let service = createSettlement({ store, config, adapters: a, now: () => now });
  await assert.rejects(service.act(id, 'prepare_conversion'));
  await assert.rejects(service.act(id, 'prepare_conversion'));
  assert.equal(calls, 1);
  store.update(id, (o) => {
    o.state = 'payment_pending';
    o.settlement = { state: 'awaiting_receipt' };
  });
  a.quote = async (o) => ({ ...(await adapters().quote(o)), minimumOutputAtomic: '9999999' });
  await assert.rejects(service.act(id, 'prepare_conversion'));
  store.update(id, (o) => {
    o.state = 'payment_pending';
    o.settlement = { state: 'awaiting_receipt' };
  });
  a.quote = adapters().quote;
  await service.act(id, 'prepare_conversion');
  service = createSettlement({ store, config, adapters: a, now: () => now + 601 });
  await assert.rejects(service.act(id, 'begin_conversion'));
  service = createSettlement({ store, config, adapters: a, now: () => now });
  store.update(id, (o) => (o.snapshot.receipts[0].blockHeight = null));
  await assert.rejects(service.act(id, 'begin_conversion'));
  store.update(id, (o) => {
    o.snapshot = snapshot(o);
    o.settlement = {
      state: 'topup_submitted',
      topupTxid: '0x' + 'e'.repeat(64),
      topupPlan: { token, network: 'base', from: buffer, to: deposit, amountAtomic: '10000000' },
    };
  });
  a.verifyProviderCredit = async () => ({ type: 'TOPUP', currency: 'USD', amountUsd: '100' });
  await assert.rejects(service.act(id, 'check_topup'));
  assert.equal(store.get(id).settlement.state, 'topup_submitted');
});
test('gateway adapter binds existing session and never retries an uncertain execution quote', async () => {
  let calls = 0;
  const a = createGatewayAdapter({
    origin: 'https://gateway.example',
    session: async () => 's'.repeat(32),
    config,
    fetcher: async (_url, opts) => {
      calls++;
      assert.equal(opts.redirect, 'manual');
      const body = JSON.parse(opts.body);
      assert.equal(body.recipientAddress, buffer);
      return new Response('{}', { status: 502 });
    },
  });
  await assert.rejects(a.quote(order()));
  assert.equal(calls, 1);
});
test('canonical stablecoin evidence rejects wrong chain, reorg, failed and ambiguous transfers', async () => {
  const txid = '0x' + 'a'.repeat(64),
    blockHash = '0x' + 'b'.repeat(64),
    contract = '0x' + 'c'.repeat(40);
  const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const log = {
    address: contract,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      topic(buffer),
      topic(deposit),
    ],
    data: '0x' + 10000000n.toString(16).padStart(64, '0'),
    logIndex: '0x0',
  };
  let chain = '0x2105',
    status = '0x1',
    hash = blockHash,
    logs = [log];
  const fetcher = async (_url, opts) => {
    const { method } = JSON.parse(opts.body);
    const result = {
      eth_chainId: chain,
      eth_getTransactionReceipt: {
        transactionHash: txid,
        status,
        blockHash,
        blockNumber: '0x10',
        logs,
      },
      eth_getBlockByNumber: { hash },
      eth_blockNumber: '0x30',
    }[method];
    return Response.json({ result });
  };
  const evidence = createEvmEvidence({
    rpcUrl: 'https://rpc.example',
    chainId: 8453,
    tokenContract: contract,
    fetcher,
  });
  const expected = { from: buffer, to: deposit, amountAtomic: '10000000' };
  assert.equal((await evidence.transfer(txid, expected)).confirmed, true);
  chain = '0x1';
  await assert.rejects(evidence.transfer(txid, expected));
  chain = '0x2105';
  status = '0x0';
  await assert.rejects(evidence.transfer(txid, expected));
  status = '0x1';
  hash = 'other';
  await assert.rejects(evidence.transfer(txid, expected));
  hash = blockHash;
  logs = [log, log];
  await assert.rejects(evidence.transfer(txid, expected));
});

test('buffered HTTP contract persists JSON before Pay and wallet txid alone cannot advance', async (t) => {
  const store = await fixture(t);
  store.update(id, (o) => {
    o.fundingMode = 'prepaid';
  });
  const c = {
    ...config,
    network: 'mainnet',
    fundingMode: 'shielded_buffer',
    checkoutEnabled: true,
    recipient: ua,
    adminToken: 'a'.repeat(32),
    markupBps: 500,
    maxUsd: 200,
  };
  const catalog = {
    fetchedAt: new Date().toISOString(),
    vouchers: [
      {
        voucherId: 1,
        brandName: 'Fixture',
        name: 'Fixture card',
        countryCode: 'US',
        currency: 'USD',
        denominationMode: 'FIXED',
        denominations: [10],
        minAmount: 10,
        maxAmount: 10,
      },
    ],
  };
  const provider = {
    request: async (path) => {
      if (path.startsWith('/quote'))
        return { voucherId: 1, faceAmount: 10, currency: 'USD', payableAmount: 10 };
      throw Error('Prepaid balance must not be used');
    },
  };
  let quotes = 0;
  const a = {
    ...adapters(),
    quote: async (o) => {
      quotes++;
      return adapters().quote(o);
    },
  };
  const app = createApp({
    config: c,
    store,
    provider,
    catalog,
    clock: () => now,
    settlementAdapters: a,
    priceFetcher: async () => Response.json({ zcash: { usd: 10, last_updated_at: now } }),
  });
  async function call(path, body, token) {
    let status = 200,
      out;
    const req = {
      url: path,
      method: body ? 'POST' : 'GET',
      headers: { origin: c.origin, ...(token ? { authorization: 'Bearer ' + token } : {}) },
      socket: { remoteAddress: 'test' },
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(JSON.stringify(body));
      },
    };
    const res = {
      setHeader() {},
      writeHead(code) {
        status = code;
      },
      end(value) {
        out = JSON.parse(value);
      },
    };
    await app.handler(req, res);
    return { status, data: out };
  }
  assert.equal(
    (
      await call(
        '/internal/heartbeat',
        { network: 'mainnet', recipient: ua, caughtUp: true },
        c.adminToken,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call('/api/orders', { voucherId: 1, amount: 10, replyAddress: 'u1bad' })).status,
    400,
  );
  const created = await call('/api/orders', { voucherId: 1, amount: 10, replyAddress: reply });
  assert.equal(created.status, 201);
  const { order: o, token: secret } = created.data;
  assert.equal(store.get(o.id).state, 'quoted');
  assert.equal(parsePaymentMemo(store.get(o.id).paymentMemo, 'mainnet').replyAddress, reply);
  assert.equal((await call('/api/orders/' + o.id)).status, 404);
  await call('/api/orders/' + o.id + '/pay', {}, secret);
  await call('/api/orders/' + o.id + '/submitted', { txid: 'f'.repeat(64) }, secret);
  await app.tick();
  assert.equal(quotes, 0);
  assert.equal(
    (
      await call(
        '/internal/settlement',
        { orderId: o.id, action: 'prepare_conversion' },
        c.adminToken,
      )
    ).status,
    409,
  );
  const watched = (await call('/internal/orders', undefined, c.adminToken)).data.orders.find(
    (r) => r.id === o.id,
  );
  assert.equal(watched.paymentMemo, store.get(o.id).paymentMemo);
  const paid = store.get(o.id);
  const proof = snapshot(paid);
  assert.equal(
    (await call('/internal/receipt', { orderId: o.id, snapshot: proof }, c.adminToken)).status,
    200,
  );
  await app.tick();
  assert.equal(quotes, 1);
  assert.equal(store.get(o.id).settlement.state, 'conversion_ready');
  assert.equal((await call('/api/orders/' + o.id, undefined, secret)).status, 200);
});

const solKey = (n) => base58.encode(new Uint8Array(32).fill(n));
const solSig = (n) => base58.encode(new Uint8Array(64).fill(n));
async function solFixtureAdapters(c) {
  const mint = address(SOLANA_USDC.mint),
    tokenProgram = address(SOLANA_USDC.program);
  const [source] = await findAssociatedTokenPda({
    owner: address(c.bufferAddress),
    mint,
    tokenProgram,
  });
  const [destination] = await findAssociatedTokenPda({
    owner: address(c.providerDepositAddress),
    mint,
    tokenProgram,
  });
  const info = (owner, addr, amount) => ({
    address: addr,
    owner: tokenProgram,
    executable: false,
    data: {
      program: 'spl-token',
      parsed: {
        type: 'account',
        info: { owner, mint, state: 'initialized', tokenAmount: { amount, decimals: 6 } },
      },
    },
  });
  const evidence = (txid, from, to, src, dst, amountAtomic) => {
    const balance = (accountIndex, owner, amount) => ({
      accountIndex,
      owner,
      mint,
      programId: tokenProgram,
      uiTokenAmount: { amount, decimals: 6 },
    });
    return verifySolanaTransferEvidence(
      {
        genesisHash: SOLANA_USDC.genesisHash,
        finalizedSlot: 101,
        status: { slot: 100, err: null, confirmationStatus: 'finalized' },
        transaction: {
          slot: 100,
          meta: {
            err: null,
            preTokenBalances: [balance(0, from, amountAtomic), balance(1, to, '0')],
            postTokenBalances: [balance(0, from, '0'), balance(1, to, amountAtomic)],
          },
          transaction: {
            signatures: [txid],
            message: {
              accountKeys: [
                { pubkey: src, signer: false },
                { pubkey: dst, signer: false },
                { pubkey: from, signer: true },
              ],
              instructions: [
                {
                  program: 'spl-token',
                  programId: tokenProgram,
                  parsed: {
                    type: 'transferChecked',
                    info: {
                      source: src,
                      destination: dst,
                      authority: from,
                      mint,
                      tokenAmount: { amount: amountAtomic, decimals: 6 },
                    },
                  },
                },
              ],
            },
          },
        },
      },
      { txid, from, to, amountAtomic, sourceAccount: src, destinationAccount: dst },
    );
  };
  return {
    ...adapters(),
    quote: async (o) => ({
      ...(await adapters().quote(o)),
      destinationAsset: SOLANA_USDC.asset,
      recipientAddress: c.bufferAddress,
    }),
    conversionStatus: async () => ({
      orderId: 'gateway-1',
      status: 'SUCCESS',
      originTransactions: [{ hash: 'd'.repeat(64) }],
      destinationTransactions: [{ hash: solSig(8) }],
    }),
    verifyBufferReceipt: async () =>
      evidence(solSig(8), solKey(9), c.bufferAddress, solKey(10), source, '10500000'),
    prepareTopup: async () =>
      prepareSolanaUsdcTopup({
        from: c.bufferAddress,
        to: c.providerDepositAddress,
        amountAtomic: '10000000',
        sourceAccountInfo: info(c.bufferAddress, source, '10500000'),
        destinationAccountInfo: info(c.providerDepositAddress, destination, '0'),
        latestBlockhash: { blockhash: solKey(11), lastValidBlockHeight: 500 },
        feeLamports: '5000',
        maxFeeLamports: '5000',
        maxRentLamports: '0',
        solBalanceLamports: '5000',
        genesisHash: SOLANA_USDC.genesisHash,
      }),
    verifyTopup: async (_o, state) =>
      evidence(
        state.topupTxid,
        c.bufferAddress,
        c.providerDepositAddress,
        source,
        destination,
        '10000000',
      ),
  };
}
for (const outcome of ['success', 'rejected', 'ambiguous', 'record_failed'])
  test('offline Solana operator/coordinator flow: ' + outcome, async (t) => {
    const store = await fixture(t);
    const c = {
      ...config,
      settlementAsset: SOLANA_USDC.asset,
      settlementNetwork: 'sol',
      solanaMaxFeeLamports: '5000',
      solanaMaxRentLamports: '0',
      bufferAddress: solKey(2),
      providerDepositAddress: solKey(3),
    };
    const a = await solFixtureAdapters(c);
    const service = createSettlement({ store, config: c, adapters: a, now: () => now });
    for (const name of ['prepare_conversion', 'begin_conversion']) await service.act(id, name);
    await service.act(id, 'submit_conversion', { txid: 'd'.repeat(64) });
    await service.act(id, 'check_conversion');
    await service.act(id, 'prepare_topup');
    const events = [];
    const wallet = {
      features: {
        'standard:connect': {
          connect: async () => ({
            accounts: [{ address: c.bufferAddress, chains: ['solana:mainnet'] }],
          }),
        },
        'solana:signAndSendTransaction': {
          signAndSendTransaction: async () => {
            events.push('wallet');
            assert.equal(store.get(id).settlement.state, 'topup_signing');
            if (outcome === 'rejected') throw Error('wallet rejected');
            if (outcome === 'ambiguous') return [];
            return [{ signature: base58.decode(solSig(7)) }];
          },
        },
      },
    };
    const operator = createOperatorSolana({
      wallet,
      getOrder: async () => store.get(id),
      getCurrentBlockHeight: async () => 499,
      act: async (orderId, name, input) => {
        events.push(name);
        if (name === 'submit_topup' && outcome === 'record_failed')
          throw Error('response unavailable');
        return service.act(orderId, name, input);
      },
    });
    if (outcome !== 'success') {
      await assert.rejects(operator.approveTopup(id));
      assert.equal(store.get(id).settlement.state, 'topup_signing');
      await assert.rejects(operator.approveTopup(id));
      assert.equal(events.filter((e) => e === 'wallet').length, 1);
      assert.equal(store.get(id).settlement.topupTxid, undefined);
      return;
    }
    await operator.approveTopup(id);
    assert.deepEqual(events, ['begin_topup', 'wallet', 'submit_topup']);
    await service.act(id, 'check_topup');
    assert.equal(store.get(id).settlement.state, 'provider_credited');
    assert.equal(store.get(id).settlement.retainedMarginAtomic, '500000');
    let purchases = 0;
    const fulfillment = createFulfillment({
      store,
      config: c,
      now: () => now,
      provider: {
        request: async (path) => {
          if (path.startsWith('/quote'))
            return { currency: 'USD', voucherId: 1, faceAmount: 10, payableAmount: 10 };
          if (path.startsWith('/clientOrderIdStatus')) throw new ProviderError(404);
          if (path === '/orders') {
            purchases++;
            return { status: 6, giftCardDetails: { code: 'solana-fixture-only' } };
          }
          throw Error('Unexpected fixture request');
        },
      },
    });
    await fulfillment.process(store.get(id));
    await fulfillment.process(store.get(id));
    assert.equal(purchases, 1);
    await service.act(id, 'prepare_reply');
    await service.act(id, 'begin_reply');
    await service.act(id, 'submit_reply', { txid: 'f'.repeat(64) });
    await service.act(id, 'check_reply');
    assert.equal(store.get(id).settlement.state, 'reply_confirmed');
  });
