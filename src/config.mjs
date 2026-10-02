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
