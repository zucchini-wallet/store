import test from 'node:test';
import assert from 'node:assert/strict';
import { base58, base64 } from '@scure/base';
import { getTransactionDecoder, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { createSolanaRpc } from '../src/solana-rpc.mjs';
import { SOLANA_USDC, validateSolanaTopupPlan } from '../src/solana-settlement.mjs';

const key = (n) => base58.encode(new Uint8Array(32).fill(n));
const from = key(2),
  to = key(3),
  signature = base58.encode(new Uint8Array(64).fill(7));
const approved = {
  from,
  to,
  amountAtomic: '2500000',
  maxFeeLamports: '6000',
  maxRentLamports: '0',
};
const context = (value, slot = 100) => ({ context: { slot }, value });
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
        tokenAmount: { decimals: 6, amount },
      },
    },
  },
});
const responses = () => ({
  getGenesisHash: SOLANA_USDC.genesisHash,
  getLatestBlockhash: context({ blockhash: key(9), lastValidBlockHeight: 500 }),
  getMultipleAccounts: context([account(from, '10000000'), account(to, '0')]),
  getBalance: context(5500),
  getFeeForMessage: context(5000),
  getBlockHeight: 499,
  getSlot: 101,
  getSignatureStatuses: context([{ confirmationStatus: 'finalized', err: null, slot: 100 }]),
});
function mock(overrides = {}, transform) {
  const values = { ...responses(), ...overrides };
  const calls = [];
  const rpc = createSolanaRpc({
    url: 'https://rpc.example.test/merchant',
    fetcher: async (url, options) => {
      assert.equal(url, 'https://rpc.example.test/merchant');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      const call = JSON.parse(options.body);
      calls.push(call);
      assert.equal(call.jsonrpc, '2.0');
      assert.ok(Object.hasOwn(values, call.method), 'Unexpected RPC method: ' + call.method);
      const result =
        typeof values[call.method] === 'function'
          ? values[call.method](call.params)
          : structuredClone(values[call.method]);
      const body = { jsonrpc: '2.0', id: call.id, result };
      return transform ? transform(body, call) : Response.json(body);
    },
  });
  return { rpc, calls, values };
}
function transaction(plan) {
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(base64.decode(plan.transactionBase64)).messageBytes,
  );
  const sourceIndex = message.staticAccounts.indexOf(plan.sourceAccount);
  const destinationIndex = message.staticAccounts.indexOf(plan.destinationAccount);
  const tokenBalance = (accountIndex, owner, amount) => ({
    accountIndex,
    owner,
    mint: SOLANA_USDC.mint,
    programId: SOLANA_USDC.program,
    uiTokenAmount: { decimals: 6, amount },
  });
  return {
    slot: 100,
    version: 'legacy',
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      preTokenBalances: [
        tokenBalance(sourceIndex, from, '10000000'),
        tokenBalance(destinationIndex, to, '0'),
      ],
      postTokenBalances: [
        tokenBalance(sourceIndex, from, '7500000'),
        tokenBalance(destinationIndex, to, '2500000'),
      ],
    },
    transaction: {
      signatures: [signature],
      message: {
        recentBlockhash: message.lifetimeToken,
        accountKeys: message.staticAccounts.map((pubkey, index) => ({
          pubkey,
          signer: index === 0,
          writable: index < 3,
        })),
        instructions: [
          {
            programId: SOLANA_USDC.program,
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: {
                source: plan.sourceAccount,
                destination: plan.destinationAccount,
                authority: from,
                mint: SOLANA_USDC.mint,
                tokenAmount: { decimals: 6, amount: '2500000' },
              },
            },
          },
        ],
      },
    },
  };
}

test('RPC payment construction prices the exact unsigned message with finalized existing accounts', async () => {
  const { rpc, calls } = mock();
  const plan = await rpc.preparePayment(approved);
  assert.equal(await validateSolanaTopupPlan(plan, approved), true);
  assert.equal(plan.feeLamports, '5000');
  assert.equal(plan.amountAtomic, '2500000');
  assert.equal(plan.maxRentLamports, '0');
  assert.deepEqual(
    calls.map((c) => c.method),
    [
      'getGenesisHash',
      'getLatestBlockhash',
      'getMultipleAccounts',
      'getBalance',
      'getFeeForMessage',
    ],
  );
  const accountsCall = calls.find((c) => c.method === 'getMultipleAccounts');
  assert.deepEqual(accountsCall.params, [
    [plan.sourceAccount, plan.destinationAccount],
    { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: 100 },
  ]);
  assert.deepEqual(calls.find((c) => c.method === 'getFeeForMessage').params, [
    plan.messageBase64,
    { commitment: 'finalized', minContextSlot: 100 },
  ]);
  assert.equal(await rpc.getCurrentBlockHeight(), 499);
  assert.deepEqual(calls.at(-1).params, [{ commitment: 'finalized' }]);
});

test('RPC preparation rejects unsupported rent, stale/wrong accounts, ambiguous fees and unsafe numbers', async () => {
  for (const patch of [
    { from: 'bad' },
    { to: from },
    { amountAtomic: '0' },
    { amountAtomic: '1.1' },
    { maxFeeLamports: undefined },
    { maxRentLamports: undefined },
    { maxRentLamports: '1' },
  ]) {
    const { rpc, calls } = mock();
    await assert.rejects(rpc.preparePayment({ ...approved, ...patch }));
    assert.equal(calls.length, 0);
  }
  const wrong = account(to, '10000000');
  for (const overrides of [
    { getGenesisHash: 'devnet' },
    { getMultipleAccounts: context([account(from, '10000000'), null]) },
    { getMultipleAccounts: context([wrong, account(to, '0')]) },
    { getMultipleAccounts: context([account(from, '10000000'), account(to, '0')], 99) },
    { getMultipleAccounts: context([account(from, '1000000'), account(to, '0')]) },
    { getBalance: context(4999) },
    { getBalance: context(Number.MAX_SAFE_INTEGER + 1) },
    { getFeeForMessage: context(null) },
    { getFeeForMessage: context(0) },
    { getFeeForMessage: context(6001) },
    { getFeeForMessage: context(5000, 99) },
    { getLatestBlockhash: context({ blockhash: key(9), lastValidBlockHeight: 0 }) },
  ])
    await assert.rejects(mock(overrides).rpc.preparePayment(approved));
});

test('RPC finalized payment verification binds the entire approved message and transaction', async () => {
  const { rpc, values, calls } = mock();
  const plan = await rpc.preparePayment(approved);
  values.getTransaction = transaction(plan);
  calls.length = 0;
  const evidence = await rpc.verifyTopup(plan, signature);
  assert.equal(evidence.confirmed, true);
  assert.equal(evidence.from, from);
  assert.equal(evidence.to, to);
  assert.equal(evidence.amountAtomic, '2500000');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getGenesisHash', 'getSignatureStatuses', 'getTransaction', 'getSlot'],
  );
  assert.deepEqual(calls.find((c) => c.method === 'getSignatureStatuses').params, [
    [signature],
    { searchTransactionHistory: true },
  ]);
  assert.deepEqual(calls.find((c) => c.method === 'getTransaction').params, [
    signature,
    { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
  ]);
  for (const change of [
    (t) => (t.transaction.message.recentBlockhash = key(8)),
    (t) => (t.transaction.message.accountKeys[0].writable = false),
    (t) => t.transaction.message.instructions.push({ program: 'memo', programId: key(8) }),
    (t) => (t.meta.innerInstructions = [{ instructions: [{ programId: key(8) }] }]),
    (t) => (t.meta.fee = 6000),
    (t) => (t.version = 0),
    (t) => (t.meta.postTokenBalances[1].owner = from),
    (t) => (t.transaction.signatures[0] = base58.encode(new Uint8Array(64).fill(8))),
  ]) {
    values.getTransaction = transaction(plan);
    change(values.getTransaction);
    await assert.rejects(rpc.verifyTopup(plan, signature));
  }
  values.getTransaction = transaction(plan);
  values.getSignatureStatuses = context([
    { confirmationStatus: 'confirmed', err: null, slot: 100 },
  ]);
  await assert.rejects(rpc.verifyTopup(plan, signature));
  values.getSignatureStatuses = context([null]);
  await assert.rejects(rpc.verifyTopup(plan, signature));
  values.getTransaction = null;
  await assert.rejects(rpc.verifyTopup(plan, signature));
});

test('RPC evidence rejects invalid transaction references before transport and wrong network before reads', async () => {
  const { rpc, calls } = mock({ getGenesisHash: 'devnet' });
  await assert.rejects(rpc.readTransferEvidence('bad'));
  assert.equal(calls.length, 0);
  await assert.rejects(rpc.readTransferEvidence(signature), /Wrong Solana network/);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getGenesisHash'],
  );
});

test('RPC transport rejects mismatched envelopes, upstream errors and oversized responses without leaking details', async () => {
  for (const transform of [
    (body) => Response.json({ ...body, id: body.id + 1 }),
    (body) => Response.json({ ...body, jsonrpc: '1.0' }),
    (body) => Response.json({ ...body, error: { message: 'secret upstream detail' } }),
    () => new Response('secret upstream detail', { status: 502 }),
    () => new Response('{'),
    () => new Response(' '.repeat(1000001)),
    () => new Response('small', { headers: { 'Content-Length': '1000001' } }),
  ]) {
    const { rpc } = mock({}, transform);
    await assert.rejects(rpc.getCurrentBlockHeight(), (e) => {
      assert.doesNotMatch(e.message, /secret upstream detail/);
      return true;
    });
  }
  const rpc = createSolanaRpc({
    url: 'https://rpc.example.test/private-key',
    fetcher: async () => {
      throw Error('private-key request failed');
    },
  });
  await assert.rejects(rpc.getCurrentBlockHeight(), (e) => {
    assert.equal(e.message, 'Solana RPC unavailable');
    return true;
  });
  for (const url of [
    'http://rpc.example.test',
    'https://user:password@rpc.example.test',
    'https://rpc.example.test/#secret',
  ])
    assert.throws(() => createSolanaRpc({ url }));
});
