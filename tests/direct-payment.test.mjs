import test from 'node:test';
import assert from 'node:assert/strict';
import { base58, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { SOLANA_USDC } from '../src/solana-settlement.mjs';
import {
  validateTransparentRefundAddress,
  validateDirectInvoice,
  resolveDirectInvoiceDestination,
  bindDirectSwapQuote,
  directPaymentUri,
} from '../src/direct-payment.mjs';

// Synthetic public account/transaction evidence; no wallet keys or service calls.
const now = 1800000000;
const externalOrderId = '00000000-0000-4000-8000-000000000001';
const gatewayOrderId = '00000000-0000-4000-8000-000000000002';
const check58 = createBase58check(sha256);
const transparent = (marker, version = [0x1c, 0xb8]) =>
  check58.encode(Uint8Array.from([...version, ...new Uint8Array(20).fill(marker)]));
const owner = base58.encode(new Uint8Array(32).fill(2));
const otherOwner = base58.encode(new Uint8Array(32).fill(3));
const refundAddress = transparent(1);
const depositAddress = transparent(2);
const providerSignature = 'ed25519:' + base58.encode(new Uint8Array(64).fill(7));
const invoice = () => ({
  externalOrderId,
  orderId: 'cr-order-1',
  state: 'WAITING_FOR_PAYMENT',
  coin: 'USDC',
  network: 'Solana',
  mint: SOLANA_USDC.mint,
  amountAtomic: '5000000',
  recipientType: 'owner',
  recipient: owner,
  expiresAt: now + 1800,
});
const invoicePolicy = () => ({
  externalOrderId,
  now,
  requiredRemainingSeconds: 120,
  maxAmountAtomic: '200000000',
});
async function destinationEvidence() {
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
const quote = () => ({
  orderId: gatewayOrderId,
  providerQuoteId: 'quote-1',
  providerSignature,
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
  deadline: now + 600,
});
async function bindingOptions() {
  return {
    externalOrderId,
    invoice: invoice(),
    destinationEvidence: await destinationEvidence(),
    quote: quote(),
    refundAddress,
    maxInputZatoshis: '13000000',
    maxAmountAtomic: '200000000',
    now,
    requiredRemainingSeconds: 120,
    settlementMarginSeconds: 300,
  };
}

test('direct deposits and refunds require actual mainnet transparent address checksums', () => {
  assert.equal(validateTransparentRefundAddress(refundAddress), refundAddress);
  const p2sh = transparent(1, [0x1c, 0xbd]);
  assert.equal(validateTransparentRefundAddress(p2sh), p2sh);
  for (const value of [
    't1' + 'A'.repeat(33),
    refundAddress.slice(0, -1) + (refundAddress.endsWith('1') ? '2' : '1'),
    transparent(1, [0x1d, 0x25]),
    transparent(1, [0x00]),
    'u1not-a-transparent-refund',
    refundAddress + ' ',
    undefined,
  ])
    assert.throws(() => validateTransparentRefundAddress(value), /mainnet transparent/);
});

test('mapped direct invoice is exact, bounded, unpaid and immutable on recovery', () => {
  const validated = validateDirectInvoice(invoice(), invoicePolicy());
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(validated.amountAtomic, '5000000');
  for (const [field, value] of [
    ['externalOrderId', gatewayOrderId],
    ['orderId', 'another-provider-order'],
    ['amountAtomic', '5000001'],
    ['recipient', otherOwner],
    ['recipientType', 'token_account'],
    ['expiresAt', now + 1799],
  ]) {
    const changed = { ...invoice(), [field]: value };
    assert.throws(
      () => validateDirectInvoice(changed, { ...invoicePolicy(), previousInvoice: validated }),
      field === 'externalOrderId' ? /identity mismatch/ : /changed during recovery/,
    );
  }
  for (const amountAtomic of [
    '0',
    '05',
    '5.000000',
    '-1',
    '200000001',
    '18446744073709551616',
    5000000,
  ])
    assert.throws(
      () => validateDirectInvoice({ ...invoice(), amountAtomic }, invoicePolicy()),
      /atomic amount/,
    );
  for (const changed of [
    { state: 'PAYMENT_RECEIVED' },
    { coin: 'USDT' },
    { network: 'Solana-devnet' },
    { mint: otherOwner },
    { recipientType: undefined },
    { expiresAt: now + 119 },
    { expiresAt: now },
    { expiresAt: now + 120.5 },
  ])
    assert.throws(() => validateDirectInvoice({ ...invoice(), ...changed }, invoicePolicy()));
  assert.throws(() => validateDirectInvoice(invoice(), { ...invoicePolicy(), now: NaN }));
  assert.throws(() =>
    validateDirectInvoice(invoice(), { ...invoicePolicy(), requiredRemainingSeconds: 0 }),
  );
});

test('authoritative USDC ATA evidence resolves owner and token-account invoices without double derivation', async () => {
  const evidence = await destinationEvidence();
  const byOwner = await resolveDirectInvoiceDestination(invoice(), evidence);
  assert.equal(byOwner.owner, owner);
  assert.equal(byOwner.destinationAccount, evidence.destinationAccount);
  const byTokenAccount = await resolveDirectInvoiceDestination(
    { ...invoice(), recipientType: 'token_account', recipient: evidence.destinationAccount },
    evidence,
  );
  assert.deepEqual(byTokenAccount, byOwner);
  assert.equal(Object.isFrozen(byTokenAccount), true);
  for (const changed of [
    { recipient: otherOwner },
    { recipientType: 'token_account', recipient: owner },
    { recipientType: 'unknown' },
  ])
    await assert.rejects(
      resolveDirectInvoiceDestination({ ...invoice(), ...changed }, evidence),
      /recipient does not match/,
    );
  for (const change of [
    { genesisHash: 'devnet' },
    { commitment: 'confirmed' },
    { contextSlot: 106 },
    { contextSlot: undefined },
    { finalizedSlot: undefined },
    { owner: otherOwner },
    { destinationAccount: otherOwner },
    { accountInfo: { ...evidence.accountInfo, address: otherOwner } },
    { accountInfo: { ...evidence.accountInfo, owner: otherOwner } },
  ])
    await assert.rejects(resolveDirectInvoiceDestination(invoice(), { ...evidence, ...change }));
  const wrongMint = structuredClone(evidence);
  wrongMint.accountInfo.data.parsed.info.mint = otherOwner;
  await assert.rejects(resolveDirectInvoiceDestination(invoice(), wrongMint), /mint/);
  const fakeAta = {
    ...evidence,
    destinationAccount: otherOwner,
    accountInfo: { ...evidence.accountInfo, address: otherOwner },
  };
  await assert.rejects(resolveDirectInvoiceDestination(invoice(), fakeAta), /canonical ATA/);
});

test('direct quote binds exact USDC invoice output, capped ZEC, canonical owner and customer refund', async () => {
  const options = await bindingOptions();
  const binding = await bindDirectSwapQuote(options);
  assert.equal(binding.providerOrderId, options.invoice.orderId);
  assert.equal(binding.gatewayOrderId, gatewayOrderId);
  assert.equal(binding.recipientAddress, owner);
  assert.equal(binding.destinationAccount, options.destinationEvidence.destinationAccount);
  assert.equal(binding.amountOutAtomic, options.invoice.amountAtomic);
  assert.equal(binding.latestApprovalAt, now + 480);
  assert.equal(Object.isFrozen(binding), true);
  const tokenInvoice = {
    ...options.invoice,
    recipientType: 'token_account',
    recipient: options.destinationEvidence.destinationAccount,
  };
  const resolved = await bindDirectSwapQuote({ ...options, invoice: tokenInvoice });
  assert.equal(resolved.recipientAddress, owner);
  assert.equal(resolved.providerRecipient, tokenInvoice.recipient);
  await assert.rejects(
    bindDirectSwapQuote({ ...options, externalOrderId: gatewayOrderId }),
    /identity/,
  );
  await assert.rejects(
    bindDirectSwapQuote({
      ...options,
      quote: { ...options.quote, recipientAddress: options.destinationEvidence.destinationAccount },
    }),
    /wallet owner/,
  );
});

test('direct quote rejects preview, wrong routing, under/excess output, missing proof and transparent memos', async () => {
  const options = await bindingOptions();
  for (const changed of [
    { mode: 'preview' },
    { integrity: 'unverified' },
    { swapType: 'EXACT_INPUT' },
    { originAsset: SOLANA_USDC.asset },
    { destinationAsset: 'wrong-usdc-network' },
    { orderId: undefined },
    { providerQuoteId: undefined },
    { providerSignature: 'not-a-signature' },
    { recipientAddress: otherOwner },
    { recipientType: 'INTENTS' },
    { refundType: 'INTENTS' },
    { refundAddress: depositAddress },
    { amountOutAtomic: '4999999' },
    { amountOutAtomic: '5000001' },
    { amountInAtomic: '13000001' },
    { minimumInputAtomic: '12345679' },
    { amountInAtomic: '012345678' },
    { amountInAtomic: 12345678 },
    { depositAddress: refundAddress },
    { depositAddress: 't1' + 'A'.repeat(33) },
    { depositMemo: 'zucchini:order' },
    { depositMemo: '' },
    { depositMemo: undefined },
  ])
    await assert.rejects(
      bindDirectSwapQuote({ ...options, quote: { ...options.quote, ...changed } }),
    );
  for (const changed of [
    { maxInputZatoshis: '2100000000000001' },
    { maxInputZatoshis: undefined },
    { refundAddress: transparent(1, [0x1d, 0x25]) },
    { requiredRemainingSeconds: 0 },
    { settlementMarginSeconds: 0 },
  ])
    await assert.rejects(bindDirectSwapQuote({ ...options, ...changed }));
});

test('direct timing preserves conservative invoice settlement margin and approval cutoff', async () => {
  const options = await bindingOptions();
  const boundary = await bindDirectSwapQuote({
    ...options,
    quote: { ...options.quote, deadline: now + 120 },
    invoice: { ...options.invoice, expiresAt: now + 420 },
  });
  assert.equal(boundary.latestApprovalAt, now);
  assert.match(directPaymentUri(boundary, { now }), /amount=0\.12345678$/);
  assert.throws(() => directPaymentUri(boundary, { now: now + 1 }), /expired/);
  for (const deadline of [now, now - 1, now + 119, now + 600.5, undefined])
    await assert.rejects(
      bindDirectSwapQuote({ ...options, quote: { ...options.quote, deadline } }),
    );
  await assert.rejects(
    bindDirectSwapQuote({ ...options, invoice: { ...options.invoice, expiresAt: now + 899 } }),
    /settlement time/,
  );
  const binding = await bindDirectSwapQuote(options);
  assert.throws(() => directPaymentUri(binding, { now: now + 481 }), /expired/);
  assert.throws(
    () => directPaymentUri({ ...binding, latestApprovalAt: binding.depositDeadline }, { now }),
    /policy changed/,
  );
});

test('recovered swap cannot change quote, payer refund, invoice, amounts, accounts or timing', async () => {
  const options = await bindingOptions();
  const first = await bindDirectSwapQuote(options);
  const recovered = await bindDirectSwapQuote({ ...options, previousBinding: first });
  assert.deepEqual(recovered, first);
  for (const changed of [
    { orderId: externalOrderId },
    { providerQuoteId: 'quote-2' },
    { providerSignature: base58.encode(new Uint8Array(64).fill(8)) },
    { amountInAtomic: '12345679' },
    { minimumInputAtomic: '12000001' },
    { depositAddress: transparent(3) },
    { deadline: now + 599 },
  ])
    await assert.rejects(
      bindDirectSwapQuote({
        ...options,
        previousBinding: first,
        quote: { ...options.quote, ...changed },
      }),
      /changed during recovery/,
    );
  for (const changed of [
    { invoice: { ...options.invoice, orderId: 'cr-order-2' } },
    { invoice: { ...options.invoice, expiresAt: now + 1801 } },
    { maxInputZatoshis: '14000000' },
    { requiredRemainingSeconds: 121 },
    { settlementMarginSeconds: 301 },
  ])
    await assert.rejects(
      bindDirectSwapQuote({ ...options, previousBinding: first, ...changed }),
      /changed during recovery/,
    );
  const newRefund = transparent(4);
  await assert.rejects(
    bindDirectSwapQuote({
      ...options,
      previousBinding: first,
      refundAddress: newRefund,
      quote: { ...options.quote, refundAddress: newRefund },
    }),
    /changed during recovery/,
  );
});

test('direct URI contains exactly the approved deposit and full-precision ZEC amount without memo', async () => {
  const options = await bindingOptions();
  for (const [amountInAtomic, expected] of [
    ['1', '0.00000001'],
    ['100000000', '1.00000000'],
    ['2100000000000000', '21000000.00000000'],
  ]) {
    const binding = await bindDirectSwapQuote({
      ...options,
      maxInputZatoshis: amountInAtomic,
      quote: { ...options.quote, amountInAtomic, minimumInputAtomic: amountInAtomic },
    });
    const uri = directPaymentUri(binding, { now });
    assert.equal(uri, `zcash:${depositAddress}?amount=${expected}`);
    assert.equal(new URL(uri).searchParams.has('memo'), false);
  }
  const binding = await bindDirectSwapQuote(options);
  assert.throws(
    () => directPaymentUri({ ...binding, amountInAtomic: '13000001' }, { now }),
    /amount/,
  );
  assert.throws(
    () => directPaymentUri({ ...binding, depositMemo: 'unsafe-memo' }, { now }),
    /policy/,
  );
});
