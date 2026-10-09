import test from 'node:test';
import assert from 'node:assert/strict';
import { base58 } from '@scure/base';
import { address, getTransactionDecoder, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  SOLANA_USDC,
  verifySolanaTransferEvidence,
  prepareSolanaUsdcTopup,
  isSolanaSignature,
  validateSolanaTopupPlan,
} from '../src/solana-settlement.mjs';
import { approveSolanaTopup } from '../public/solana-topup.js';
const key = (n) => base58.encode(new Uint8Array(32).fill(n));
const signature = base58.encode(new Uint8Array(64).fill(7)),
  owner = key(2),
  recipient = key(3),
  source = key(4),
  destination = key(5);
const balance = (index, wallet, amount) => ({
  accountIndex: index,
  mint: SOLANA_USDC.mint,
  owner: wallet,
  programId: SOLANA_USDC.program,
  uiTokenAmount: { amount, decimals: 6 },
});
const fixture = () => ({
  genesisHash: SOLANA_USDC.genesisHash,
  finalizedSlot: 101,
  status: { confirmationStatus: 'finalized', err: null, slot: 100 },
  transaction: {
    slot: 100,
    meta: {
      err: null,
      preTokenBalances: [balance(0, owner, '20000000'), balance(1, recipient, '0')],
      postTokenBalances: [balance(0, owner, '10000000'), balance(1, recipient, '10000000')],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: source, signer: false },
          { pubkey: destination, signer: false },
          { pubkey: owner, signer: true },
        ],
        instructions: [
          {
            programId: SOLANA_USDC.program,
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: {
                source,
                destination,
                authority: owner,
                mint: SOLANA_USDC.mint,
                tokenAmount: { amount: '10000000', decimals: 6 },
              },
            },
          },
        ],
      },
    },
  },
});
const expected = { txid: signature, from: owner, to: recipient, amountAtomic: '10000000' };
test('Solana USDC requires successful finalized native-mint transfer to exact token owner', () => {
  const e = verifySolanaTransferEvidence(fixture(), expected);
  assert.equal(e.confirmed, true);
  assert.equal(e.network, 'sol');
  assert.equal(e.recipient, recipient);
  const cases = [
    (b) => (b.genesisHash = 'devnet'),
    (b) => (b.status.confirmationStatus = 'confirmed'),
    (b) => (b.status.err = { InstructionError: 1 }),
    (b) => (b.transaction.meta.err = { InstructionError: 1 }),
    (b) => (b.transaction.slot = 99),
    (b) => (b.transaction.transaction.signatures[0] = base58.encode(new Uint8Array(64).fill(8))),
    (b) => (b.transaction.meta.postTokenBalances[1].mint = key(8)),
    (b) => (b.transaction.meta.postTokenBalances[1].owner = key(8)),
    (b) => (b.transaction.meta.postTokenBalances[1].programId = key(8)),
    (b) => (b.transaction.meta.postTokenBalances[1].uiTokenAmount.decimals = 9),
    (b) => (b.transaction.meta.postTokenBalances[1].uiTokenAmount.amount = '9999999'),
    (b) => (b.transaction.transaction.message.instructions[0].parsed.info.tokenAmount.decimals = 9),
    (b) => (b.transaction.transaction.message.accountKeys[2].signer = false),
    (b) =>
      b.transaction.transaction.message.instructions.push(
        structuredClone(b.transaction.transaction.message.instructions[0]),
      ),
  ];
  for (const change of cases) {
    const b = fixture();
    change(b);
    assert.throws(() => verifySolanaTransferEvidence(b, expected));
  }
  assert.throws(() => verifySolanaTransferEvidence(fixture(), { ...expected, amountAtomic: '1' }));
  assert.throws(() =>
    verifySolanaTransferEvidence(fixture(), { ...expected, destinationAccount: source }),
  );
  assert.equal(isSolanaSignature(signature), true);
  assert.equal(isSolanaSignature('0x' + 'a'.repeat(64)), false);
});
const account = (wallet, amount) => ({
  owner: SOLANA_USDC.program,
  executable: false,
  data: {
    program: 'spl-token',
    parsed: {
      type: 'account',
      info: {
        owner: wallet,
        mint: SOLANA_USDC.mint,
        state: 'initialized',
        tokenAmount: { amount, decimals: 6 },
      },
    },
  },
});
async function inputs() {
  const mint = address(SOLANA_USDC.mint),
    tokenProgram = address(SOLANA_USDC.program);
  const [a] = await findAssociatedTokenPda({ owner: address(owner), mint, tokenProgram }),
    [b] = await findAssociatedTokenPda({ owner: address(recipient), mint, tokenProgram });
  return {
    from: owner,
    to: recipient,
    amountAtomic: '10000000',
    sourceAccountInfo: { ...account(owner, '20000000'), address: a },
    destinationAccountInfo: { ...account(recipient, '0'), address: b },
    latestBlockhash: { blockhash: key(9), lastValidBlockHeight: 500 },
    feeLamports: '5000',
    maxFeeLamports: '5000',
    maxRentLamports: '0',
    solBalanceLamports: '10000',
    genesisHash: SOLANA_USDC.genesisHash,
  };
}
test('offline TransferChecked uses exact USDC, payer, associated accounts and bounded fee inputs', async () => {
  const values = await inputs();
  const plan = await prepareSolanaUsdcTopup(values);
  assert.equal(plan.from, owner);
  assert.equal(plan.amountAtomic, '10000000');
  assert.equal(plan.chain, 'solana:mainnet');
  assert.equal(plan.feePayer, owner);
  const tx = getTransactionDecoder().decode(Buffer.from(plan.transactionBase64, 'base64'));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.instructions.length, 1);
  const data = msg.instructions[0].data;
  assert.equal(data[0], 12);
  assert.equal(data[9], 6);
  assert.equal(
    new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true),
    10000000n,
  );
  for (const patch of [
    { solBalanceLamports: '0' },
    { amountAtomic: '9999999' },
    { genesisHash: 'testnet' },
    { sourceAccountInfo: { ...values.sourceAccountInfo, address: source } },
    { destinationAccountInfo: { ...values.destinationAccountInfo, owner: key(8) } },
  ])
    await assert.rejects(prepareSolanaUsdcTopup({ ...values, ...patch }));
});
test('operator Wallet Standard sends once and persists before approval; interruption stays uncertain', async () => {
  const plan = await prepareSolanaUsdcTopup(await inputs());
  const events = [];
  const wallet = {
    features: {
      'standard:connect': {
        connect: async () => ({ accounts: [{ address: owner, chains: ['solana:mainnet'] }] }),
      },
      'solana:signAndSendTransaction': {
        signAndSendTransaction: async (request) => {
          events.push('wallet');
          assert.equal(request.chain, 'solana:mainnet');
          return [{ signature: base58.decode(signature) }];
        },
      },
    },
  };
  const result = await approveSolanaTopup({
    wallet,
    plan,
    currentBlockHeight: 499,
    begin: async () => events.push('persist'),
    record: async () => events.push('record'),
  });
  assert.equal(result, signature);
  assert.deepEqual(events, ['persist', 'wallet', 'record']);
  events.length = 0;
  wallet.features['solana:signAndSendTransaction'].signAndSendTransaction = async () => {
    events.push('wallet');
    throw Error('interrupted');
  };
  await assert.rejects(
    approveSolanaTopup({
      wallet,
      plan,
      currentBlockHeight: 499,
      begin: async () => events.push('persist'),
      record: async () => events.push('record'),
    }),
  );
  assert.deepEqual(events, ['persist', 'wallet']);
  await assert.rejects(
    approveSolanaTopup({
      wallet,
      plan,
      currentBlockHeight: 501,
      begin: async () => events.push('persist'),
      record: async () => events.push('record'),
    }),
  );
});

test('serialized top-up rejects tampering before wallet access', async () => {
  const plan = await prepareSolanaUsdcTopup(await inputs());
  assert.equal(await validateSolanaTopupPlan(plan), true);
  for (const patch of [
    { from: recipient },
    { to: owner },
    { amountAtomic: '11000000' },
    { token: 'fake' },
    { feePayer: recipient },
    { feeLamports: '0' },
    { sourceAccount: source },
    { messageBase64: 'AA==' },
  ])
    await assert.rejects(validateSolanaTopupPlan({ ...plan, ...patch }));
  const bytes = Buffer.from(plan.transactionBase64, 'base64');
  bytes[1] = 1; // Nonzero signature must not reach a wallet.
  const signed = { ...plan, transactionBase64: bytes.toString('base64') };
  await assert.rejects(validateSolanaTopupPlan(signed));
  let touched = false;
  await assert.rejects(
    approveSolanaTopup({
      wallet: {
        features: {
          'standard:connect': {
            connect: async () => {
              touched = true;
            },
          },
        },
      },
      plan: signed,
      currentBlockHeight: 499,
    }),
  );
  assert.equal(touched, false);
});
test('fee and missing/rent-dependent token accounts fail closed offline', async () => {
  const values = await inputs();
  for (const patch of [
    { maxFeeLamports: undefined },
    { maxFeeLamports: '4999' },
    { maxRentLamports: undefined },
    { maxRentLamports: '1' },
    { feeLamports: undefined },
    { feeLamports: '0' },
    { feeLamports: '-1' },
    { feeLamports: '10001' },
    { solBalanceLamports: undefined },
    { destinationAccountInfo: null },
    { sourceAccountInfo: null },
    { destinationAccountInfo: { ...values.destinationAccountInfo, data: null } },
  ])
    await assert.rejects(prepareSolanaUsdcTopup({ ...values, ...patch }));
});
