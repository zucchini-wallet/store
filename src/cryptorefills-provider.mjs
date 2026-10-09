import { isIP } from 'node:net';

export class CryptorefillsError extends Error {
  constructor(status, code) {
    super('Cryptorefills request could not be completed.');
    this.status = status;
    // Never propagate upstream messages, which may contain customer data.
    this.code = typeof code === 'string' && /^[A-Za-z_]{1,80}$/.test(code) ? code : undefined;
  }
}

// No credentials are loaded here. Composition supplies an already-authorized key.
// Responses remain raw: v6 payment/delivery shapes have not yet been verified.
export function createCryptorefillsProvider({ key }, { fetcher = fetch } = {}) {
  if (typeof key !== 'string' || !key.trim()) throw Error('Partner key required');
  async function request(method, path, body, customerIp) {
    if (!isIP(customerIp ?? '')) throw Error('Trusted customer IP required');
    const response = await fetcher('https://api.cryptorefills.com' + path, {
      method,
      headers: {
        'X-CR-Partner-Key': key,
        'X-CR-Forwarded-For': customerIp,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (text.length > 1e6) throw new CryptorefillsError(502);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new CryptorefillsError(502);
    }
    if (!response.ok) throw new CryptorefillsError(response.status, data?.code);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CryptorefillsError(502);
    return data;
  }
  const path = (id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw Error('Invalid provider order ID');
    return '/v6/partner/orders/' + id;
  };
  return {
    createOrder(order) {
      if (
        !order.providerConsent?.terms ||
        !order.providerConsent?.privacy ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email ?? '') ||
        !order.providerProduct?.brand_name ||
        !order.providerProduct?.country_code ||
        !order.providerProduct?.denomination ||
        !order.id
      )
        throw Error('Provider checkout requirements missing');
      return request(
        'POST',
        '/v6/partner/orders',
        {
          external_order_id: order.id,
          deliveries: [{ ...order.providerProduct, beneficiary_account: order.email }],
          payment: { type: 'via', coin: 'USDC', network: 'Solana', payment_via: 'USER_WALLET' },
          user: { email: order.email },
          lang: 'en',
        },
        order.customerIp,
      );
    },
    getOrder: (id, ip) => request('GET', path(id), undefined, ip),
    cancelOrder: (id, ip) => request('DELETE', path(id), undefined, ip),
  };
}
