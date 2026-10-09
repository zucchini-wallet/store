import { createHash, timingSafeEqual } from 'node:crypto';
const bool = (v) => v === 'true';
export function loadConfig(env = process.env) {
  const number = (k, d, min, max) => {
    const n = Number(env[k] ?? d);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw Error('Invalid ' + k);
    return n;
  };
  const origin = new URL(env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:4390').origin,
    network = env.NETWORK ?? 'mainnet';
  if (!['mainnet', 'testnet'].includes(network)) throw Error('Invalid network');
  const c = {
    origin,
    giftCardProvider: env.GIFT_CARD_PROVIDER ?? '0fiat',
    cryptorefillsPartnerId: env.CRYPTOREFILLS_PARTNER_ID,
    gatewayOrigin: env.GATEWAY_ORIGIN,
    solanaRpcUrl: env.SOLANA_RPC_URL,
    outgoingEvidenceOrigin: env.OUTGOING_EVIDENCE_ORIGIN,
    merchantAccountId: env.MERCHANT_ACCOUNT_ID,
    slippageBps: number('SLIPPAGE_BPS', 100, 0, 1000),
    fundingMode: env.FUNDING_MODE ?? 'prepaid',
    settlementAsset: env.SETTLEMENT_ASSET,
    settlementNetwork: env.SETTLEMENT_NETWORK,
    solanaMaxFeeLamports: env.SOLANA_MAX_FEE_LAMPORTS,
    solanaMaxRentLamports: env.SOLANA_MAX_RENT_LAMPORTS,
    bufferAddress: env.BUFFER_ADDRESS,
    providerDepositAddress: env.PROVIDER_DEPOSIT_ADDRESS,
    conversionRefundAddress: env.CONVERSION_REFUND_ADDRESS,
    minimumRetainedMarginUsd: env.MINIMUM_RETAINED_MARGIN_USD ?? '0',
    replyAmountZatoshis: env.REPLY_AMOUNT_ZATOSHIS,
    network,
    port: number('PORT', 4390, 1, 65535),
    checkoutEnabled: bool(env.CHECKOUT_ENABLED),
    fulfillmentEnabled: bool(env.FULFILLMENT_ENABLED),
    scannerReady: bool(env.SCANNER_READY),
    recipient: env.MERCHANT_RECEIVER ?? '',
    encryptionKey: env.DATA_ENCRYPTION_KEY,
    providerFile: env.OFIAT_ENV_FILE,
    fulfillmentEmail: env.FULFILLMENT_EMAIL ?? '',
    resendKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    supportEmail: env.SUPPORT_EMAIL ?? '',
    adminToken: env.ADMIN_TOKEN ?? '',
    markupBps: number('MARKUP_BPS', 0, 0, 10000),
    confirmations: number('REQUIRED_CONFIRMATIONS', 10, 1, 100),
    maxUsd: number('MAX_ORDER_USD', 200, 1, 10000),
    dataDir: env.DATA_DIR ?? 'data',
  };
  if (!['0fiat', 'cryptorefills'].includes(c.giftCardProvider))
    throw Error('Invalid gift-card provider');
  if (c.giftCardProvider === 'cryptorefills' && c.checkoutEnabled)
    throw Error(
      'Cryptorefills live checkout is blocked pending reviewed response adapters and payment/refund policy.',
    );
  if (!['prepaid', 'shielded_buffer', 'direct_swap'].includes(c.fundingMode))
    throw Error('Invalid funding mode');
  if (c.fundingMode === 'direct_swap' && c.giftCardProvider !== 'cryptorefills')
    throw Error('Direct swap requires Cryptorefills');
  if (c.fundingMode === 'shielded_buffer' && c.checkoutEnabled)
    throw Error(
      'Buffered checkout requires reviewed settlement adapters; production activation is blocked.',
    );
  if (
    c.checkoutEnabled &&
    (!c.fulfillmentEnabled ||
      !c.scannerReady ||
      !c.recipient.startsWith(network === 'mainnet' ? 'u1' : 'utest1') ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.fulfillmentEmail) ||
      c.adminToken.length < 32 ||
      !c.providerFile ||
      !c.supportEmail ||
      new URL(origin).protocol !== 'https:')
  )
    throw Error('Live checkout configuration is incomplete.');
  return c;
}
export const secureEqual = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
