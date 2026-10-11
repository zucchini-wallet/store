import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { base58, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { createStore } from '../../src/storage.mjs';
import { createDirectSettlement } from '../../src/direct-settlement.mjs';
import { SOLANA_USDC } from '../../src/solana-settlement.mjs';

// Synthetic server-adapter contracts only. No provider/wallet transport is constructed.
const start = 1800000000;
const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000003';
const gatewayId = (id) =>
  id.slice(0, -2) + (parseInt(id.slice(-2), 16) ^ 128).toString(16).padStart(2, '0');
const check58 = createBase58check(sha256);
const transparent = (marker) =>
  check58.encode(Uint8Array.from([0x1c, 0xb8, ...new Uint8Array(20).fill(marker)]));
const owner = base58.encode(new Uint8Array(32).fill(2));
const signature = base58.encode(new Uint8Array(64).fill(7));
const refundAddress = transparent(1),
  depositAddress = transparent(2);
const draft = (id = firstId) => ({
  id,
  fundingMode: 'direct_swap',
  giftCardProvider: 'cryptorefills',
  state: 'quoted',
  quoteExpiresAt: start + 120,
  expectedUsdcAtomic: '5000000',
  maxInputZatoshis: '13000000',
  refundAddress,
  email: 'buyer@example.com',
  brand: 'Airbnb',
  country: 'US',
  faceAmount: '5.00',
  providerProductId: '20000000-0000-4000-8000-000000000000',
  direct: { state: 'draft', revision: 0 },
});
const invoice = (id) => ({
  externalOrderId: id,
  orderId: 'cr-' + id,
  state: 'WAITING_FOR_PAYMENT',
  coin: 'USDC',
  network: 'Solana',
  mint: SOLANA_USDC.mint,
  amountAtomic: '5000000',
  recipientType: 'owner',
  recipient: owner,
  expiresAt: start + 1800,
});
const quote = (id) => ({
  orderId: gatewayId(id),
  providerQuoteId: 'quote-' + id,
  providerSignature: 'ed25519:' + signature,
  mode: 'execution',
  integrity: 'provider_signature_verified',
  swapType: 'EXACT_OUTPUT',
  originAsset: 'nep141:zec.omft.near',
  destinationAsset: SOLANA_USDC.asset,
  recipientAddress: owner,
  recipientType: 'DESTINATION_CHAIN',
  refundAddress,
  refundType: 'ORIGIN_CHAIN',
  amountInAtomic: '12345678',
  minimumInputAtomic: '12000000',
  amountOutAtomic: '5000000',
  depositAddress,
  depositMemo: null,
  deadline: start + 600,
});
async function accountEvidence() {
  const [destinationAccount] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(SOLANA_USDC.mint),
    tokenProgram: SOLANA_USDC.program,
  });
  return {
    genesisHash: SOLANA_USDC.genesisHash,
    commitment: 'finalized',
    owner,
    destinationAccount,
    contextSlot: 100,
    finalizedSlot: 105,
    accountInfo: {
      address: destinationAccount,
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
            tokenAmount: { amount: '0', decimals: 6 },
          },
        },
      },
    },
  };
}
async function fixture(t, { insertDraft = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zucchini-direct-'));
  const path = join(dir, 'store.sqlite'),
    key = '11'.repeat(32);
  const f = {
    time: start,
    store: createStore(path, key),
    calls: [],
    config: {
      checkoutEnabled: true,
      fulfillmentEnabled: true,
      maxUsd: 200,
      directApprovalSeconds: 120,
      directSettlementMarginSeconds: 600,
    },
  };
  t.after(async () => {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const evidence = await accountEvidence();
  f.adapters = {
    createInvoice: async (o) => {
      f.calls.push(['createInvoice', o.id]);
      return invoice(o.id);
    },
    readInvoiceAccount: async () => {
      f.calls.push(['account']);
      return structuredClone(evidence);
    },
    quoteSwap: async (o) => {
      f.calls.push(['quoteSwap', o.id]);
      return quote(o.id);
    },
    recoverSwap: async (o) => {
      f.calls.push(['recoverSwap', o.id]);
      return quote(o.id);
    },
    notifyDeposit: async () => {
      f.calls.push(['notify']);
    },
    swapStatus: async (o) => {
      f.calls.push(['status', o.id]);
      return {
        orderId: gatewayId(o.id),
        providerQuoteId: 'quote-' + o.id,
        trackingSource: 'one_click_status',
        status: 'SUCCESS',
        amounts: { amountOutAtomic: '5000000' },
        destinationTransactions: [{ hash: signature }],
      };
    },
    verifyPayout: async (b) => {
      f.calls.push(['verify']);
      return {
        canonical: true,
        confirmed: true,
        txid: signature,
        network: 'sol',
        token: SOLANA_USDC.asset,
        to: b.recipientAddress,
        destinationAccount: b.destinationAccount,
        amountAtomic: b.amountOutAtomic,
        slot: 100,
        logIndex: '0',
      };
    },
    getInvoice: async (o) => {
      f.calls.push(['getInvoice', o.id]);
      return {
        orderId: o.direct.invoice.orderId,
        externalOrderId: o.id,
        state: 'COMPLETED',
        payment: {
          accepted: true,
          amountAtomic: '5000000',
          coin: 'USDC',
          network: 'Solana',
          recipient: owner,
        },
        delivery: {
          beneficiary: o.email,
          brand: o.brand,
          country: o.country,
          faceAmount: o.faceAmount,
          providerProductId: o.providerProductId,
          card: { code: 'synthetic-card' },
        },
      };
    },
    cancelInvoice: async (o) => {
      f.calls.push(['cancelInvoice', o.id]);
      return { orderId: o.direct.invoice.orderId, externalOrderId: o.id, state: 'CANCELLED' };
    },
  };
  if (insertDraft) f.store.insert(draft(), 'synthetic-private-capability');
  f.coordinator = () =>
    createDirectSettlement({
      store: f.store,
      config: f.config,
      adapters: f.adapters,
      now: () => f.time,
    });
  f.restart = () => {
    f.store.close();
    f.store = createStore(path, key);
    return f.coordinator();
  };
  f.prepare = async (id = firstId) => {
    const c = f.coordinator();
    await c.act(id, 'prepare');
    await c.act(id, 'prepare_swap');
    return c;
  };
  return f;
}

export {
  start,
  firstId,
  secondId,
  gatewayId,
  owner,
  signature,
  refundAddress,
  depositAddress,
  draft,
  invoice,
  quote,
  accountEvidence,
  fixture,
};
