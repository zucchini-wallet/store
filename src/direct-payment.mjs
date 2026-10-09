import { base58, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { SOLANA_USDC, tokenAccount } from './solana-settlement.mjs';

const U64_MAX = 18446744073709551615n;
const ZEC_MAX = 2100000000000000n;
const ZEC_ASSET = 'nep141:zec.omft.near';
const check58 = createBase58check(sha256);
const demand = (ok, message) => {
  if (!ok) throw Error(message);
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const identifier = (v, max = 128) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
function positiveAtomic(value, maximum, message) {
  demand(
    typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= maximum,
    message,
  );
  return BigInt(value);
}
function seconds(value, message, positive = true) {
  demand(Number.isSafeInteger(value) && value >= (positive ? 1 : 0), message);
  return value;
}
function same(previous, next, fields, message) {
  if (previous !== undefined) {
    demand(object(previous), message);
    for (const field of fields) demand(previous[field] === next[field], message);
  }
}
function signature(value) {
  try {
    return (
      typeof value === 'string' &&
      value.length <= 100 &&
      base58.decode(value.replace(/^ed25519:/, '')).length === 64
    );
  } catch {
    return false;
  }
}

// Validate the actual mainnet Base58Check payload, not merely a t1/t3 prefix.
export function validateTransparentRefundAddress(value) {
  try {
    demand(typeof value === 'string' && value.length === 35, 'Invalid transparent Zcash address');
    const payload = check58.decode(value);
    demand(
      payload.length === 22 &&
        payload[0] === 0x1c &&
        [0xb8, 0xbd].includes(payload[1]) &&
        check58.encode(payload) === value,
      'Invalid transparent Zcash address',
    );
    return value;
  } catch {
    throw Error('A valid mainnet transparent Zcash address is required');
  }
}

// Internal mapped evidence only. This module does not guess or parse a raw v6 response.
export function validateDirectInvoice(
  invoice,
  {
    externalOrderId,
    previousInvoice,
    now,
    requiredRemainingSeconds,
    maxAmountAtomic = String(U64_MAX),
  },
) {
  seconds(now, 'Invalid current time', false);
  seconds(requiredRemainingSeconds, 'Explicit invoice timing policy required');
  const maximum = positiveAtomic(maxAmountAtomic, U64_MAX, 'Invalid invoice amount limit');
  demand(
    object(invoice) &&
      uuid(externalOrderId) &&
      invoice.externalOrderId === externalOrderId &&
      identifier(invoice.orderId),
    'Provider order identity mismatch',
  );
  demand(
    invoice.state === 'WAITING_FOR_PAYMENT' &&
      invoice.coin === 'USDC' &&
      invoice.network === 'Solana' &&
      invoice.mint === SOLANA_USDC.mint,
    'Unsupported direct provider invoice',
  );
  positiveAtomic(invoice.amountAtomic, maximum, 'Invalid provider atomic amount');
  seconds(invoice.expiresAt, 'Invalid provider invoice expiry');
  demand(
    invoice.expiresAt - now >= requiredRemainingSeconds,
    'Provider invoice has insufficient time remaining',
  );
  demand(
    ['owner', 'token_account'].includes(invoice.recipientType),
    'Explicit provider recipient type required',
  );
  address(invoice.recipient);
  const result = Object.freeze({
    externalOrderId,
    orderId: invoice.orderId,
    state: invoice.state,
    coin: invoice.coin,
    network: invoice.network,
    mint: invoice.mint,
    amountAtomic: invoice.amountAtomic,
    recipient: invoice.recipient,
    recipientType: invoice.recipientType,
    expiresAt: invoice.expiresAt,
  });
  same(previousInvoice, result, Object.keys(result), 'Provider invoice changed during recovery');
  return result;
}

// Evidence must come from the server's authoritative finalized RPC adapter, never
// from a browser assertion. No boolean "verified" flag substitutes for account data.
export async function resolveDirectInvoiceDestination(invoice, evidence) {
  demand(object(invoice) && object(evidence), 'Provider account evidence required');
  const {
    genesisHash,
    commitment,
    owner,
    destinationAccount,
    accountInfo,
    contextSlot,
    finalizedSlot,
  } = evidence;
  demand(genesisHash === SOLANA_USDC.genesisHash, 'Wrong provider account network');
  demand(commitment === 'finalized', 'Finalized provider account evidence required');
  seconds(contextSlot, 'Missing finalized provider account context', false);
  seconds(finalizedSlot, 'Missing finalized provider account slot', false);
  demand(contextSlot <= finalizedSlot, 'Provider account context is not finalized');
  address(owner);
  address(destinationAccount);
  demand(accountInfo?.address === destinationAccount, 'Provider account evidence address mismatch');
  demand(
    invoice.mint === SOLANA_USDC.mint && invoice.coin === 'USDC' && invoice.network === 'Solana',
    'Unsupported direct provider invoice',
  );
  tokenAccount(accountInfo, owner);
  const [canonicalAccount] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(SOLANA_USDC.mint),
    tokenProgram: SOLANA_USDC.program,
  });
  demand(destinationAccount === canonicalAccount, 'Provider USDC account is not canonical ATA');
  demand(
    (invoice.recipientType === 'owner' && invoice.recipient === owner) ||
      (invoice.recipientType === 'token_account' && invoice.recipient === destinationAccount),
    'Provider recipient does not match verified owner and token account',
  );
  return Object.freeze({ owner, destinationAccount, contextSlot });
}

// A reviewed gateway adapter supplies this normalized EXACT_OUTPUT contract after
// verifying the provider signature and request echo. These helpers perform no I/O.
export async function bindDirectSwapQuote({
  externalOrderId,
  invoice,
  destinationEvidence,
  quote,
  refundAddress,
  maxInputZatoshis,
  maxAmountAtomic = String(U64_MAX),
  now,
  requiredRemainingSeconds,
  settlementMarginSeconds,
  previousBinding,
}) {
  const provider = validateDirectInvoice(invoice, {
    externalOrderId,
    now,
    requiredRemainingSeconds,
    maxAmountAtomic,
  });
  seconds(settlementMarginSeconds, 'Explicit settlement timing margin required');
  const maximumInput = positiveAtomic(maxInputZatoshis, ZEC_MAX, 'Invalid customer ZEC input cap');
  const refund = validateTransparentRefundAddress(refundAddress);
  demand(object(quote), 'Gateway quote required');
  const q = { ...quote };
  demand(
    uuid(q.orderId) && identifier(q.providerQuoteId, 512) && signature(q.providerSignature),
    'Gateway quote identity unavailable',
  );
  demand(
    q.mode === 'execution' &&
      q.integrity === 'provider_signature_verified' &&
      q.swapType === 'EXACT_OUTPUT' &&
      q.originAsset === ZEC_ASSET &&
      q.destinationAsset === SOLANA_USDC.asset,
    'Verified exact-output gateway quote required',
  );
  demand(
    q.recipientType === 'DESTINATION_CHAIN' &&
      q.refundType === 'ORIGIN_CHAIN' &&
      q.refundAddress === refund,
    'Gateway recipient or customer refund semantics mismatch',
  );
  const input = positiveAtomic(
    q.amountInAtomic,
    maximumInput,
    'Gateway input exceeds customer cap',
  );
  const minimumInput = positiveAtomic(
    q.minimumInputAtomic,
    ZEC_MAX,
    'Invalid minimum gateway input',
  );
  demand(minimumInput <= input, 'Gateway minimum input exceeds quoted input');
  positiveAtomic(q.amountOutAtomic, U64_MAX, 'Invalid gateway output amount');
  demand(
    q.amountOutAtomic === provider.amountAtomic,
    'Gateway output does not equal provider invoice',
  );
  const deposit = validateTransparentRefundAddress(q.depositAddress);
  demand(deposit !== refund, 'Gateway deposit cannot be the customer refund address');
  demand(q.depositMemo === null, 'Direct Zcash deposits require an explicit absent memo');
  seconds(q.deadline, 'Invalid gateway deposit deadline');
  demand(
    q.deadline - now >= requiredRemainingSeconds,
    'Gateway quote has insufficient time remaining',
  );
  demand(
    provider.expiresAt - q.deadline >= settlementMarginSeconds,
    'Gateway deposit window leaves insufficient provider settlement time',
  );
  const destination = await resolveDirectInvoiceDestination(provider, destinationEvidence);
  demand(
    q.recipientAddress === destination.owner,
    'Gateway must pay the verified provider wallet owner',
  );
  const result = Object.freeze({
    externalOrderId: provider.externalOrderId,
    providerOrderId: provider.orderId,
    providerRecipient: provider.recipient,
    providerRecipientType: provider.recipientType,
    invoiceExpiresAt: provider.expiresAt,
    mint: provider.mint,
    destinationAsset: SOLANA_USDC.asset,
    recipientAddress: destination.owner,
    destinationAccount: destination.destinationAccount,
    gatewayOrderId: q.orderId,
    providerQuoteId: q.providerQuoteId,
    providerSignature: q.providerSignature,
    swapType: q.swapType,
    originAsset: ZEC_ASSET,
    refundAddress: refund,
    amountInAtomic: q.amountInAtomic,
    minimumInputAtomic: q.minimumInputAtomic,
    amountOutAtomic: q.amountOutAtomic,
    maxInputZatoshis,
    depositAddress: deposit,
    depositMemo: null,
    depositDeadline: q.deadline,
    latestApprovalAt: q.deadline - requiredRemainingSeconds,
    requiredRemainingSeconds,
    settlementMarginSeconds,
  });
  same(previousBinding, result, Object.keys(result), 'Direct swap binding changed during recovery');
  return result;
}

export function directPaymentUri(binding, { now }) {
  demand(object(binding), 'Direct payment binding required');
  seconds(now, 'Invalid current time', false);
  seconds(binding.depositDeadline, 'Invalid bound deposit deadline');
  seconds(binding.invoiceExpiresAt, 'Invalid bound provider expiry');
  seconds(binding.requiredRemainingSeconds, 'Invalid bound approval timing policy');
  seconds(binding.settlementMarginSeconds, 'Invalid bound settlement timing policy');
  demand(
    binding.swapType === 'EXACT_OUTPUT' &&
      binding.originAsset === ZEC_ASSET &&
      binding.destinationAsset === SOLANA_USDC.asset &&
      binding.mint === SOLANA_USDC.mint &&
      binding.depositMemo === null &&
      binding.latestApprovalAt === binding.depositDeadline - binding.requiredRemainingSeconds &&
      now <= binding.latestApprovalAt &&
      binding.invoiceExpiresAt - binding.depositDeadline >= binding.settlementMarginSeconds,
    'Direct payment is expired or its bound policy changed',
  );
  const maximum = positiveAtomic(binding.maxInputZatoshis, ZEC_MAX, 'Invalid bound ZEC input cap');
  const input = positiveAtomic(binding.amountInAtomic, maximum, 'Invalid bound ZEC amount');
  const deposit = validateTransparentRefundAddress(binding.depositAddress);
  const refund = validateTransparentRefundAddress(binding.refundAddress);
  demand(deposit !== refund, 'Gateway deposit cannot be the customer refund address');
  const amount = `${input / 100000000n}.${(input % 100000000n).toString().padStart(8, '0')}`;
  return `zcash:${deposit}?amount=${amount}`;
}
