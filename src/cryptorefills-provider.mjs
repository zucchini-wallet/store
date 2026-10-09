import { isIP } from 'node:net';

export class CryptorefillsError extends Error {
  constructor(status, code, retryAfterSeconds) {
    super('Cryptorefills request could not be completed.');
    this.status = status;
    // Never propagate upstream messages, which may contain customer data.
    this.code = typeof code === 'string' && /^[A-Za-z_]{1,80}$/.test(code) ? code : undefined;
    if (status === 429) this.retryAfterSeconds = retryAfterSeconds;
  }
}

// No credentials are loaded here. Composition supplies an already-authorized key.
// Responses remain raw: v6 payment/delivery shapes have not yet been verified.
export function createCryptorefillsProvider({ key, backupKey }, { fetcher = fetch } = {}) {
  if (typeof key !== 'string' || !key.trim()) throw Error('Partner key required');
  if (
    backupKey !== undefined &&
    (typeof backupKey !== 'string' || !backupKey.trim() || backupKey === key)
  )
    throw Error('Distinct backup partner key required');
  let activeKey = key;
  let blockedUntil = 0;
  async function request(method, path, body, customerIp) {
    if (!isIP(customerIp ?? '')) throw Error('Trusted customer IP required');
    if (Date.now() < blockedUntil)
      throw new CryptorefillsError(429, undefined, Math.ceil((blockedUntil - Date.now()) / 1000));
    const serialized = body ? JSON.stringify(body) : undefined;
    const send = (requestKey) =>
      fetcher('https://api.cryptorefills.com' + path, {
        method,
        headers: {
          'X-CR-Partner-Key': requestKey,
          'X-CR-Forwarded-For': customerIp,
          'Content-Type': 'application/json',
        },
        ...(serialized ? { body: serialized } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    let response = await send(activeKey);
    // Only a confirmed authentication rejection permits one failover. Never
    // replay a timed-out order request automatically; callers must reconcile
    // using the same persisted external_order_id.
    if (response.status === 401 && activeKey === key && backupKey) {
      await response.body?.cancel();
      response = await send(backupKey);
      if (response.ok) activeKey = backupKey;
    }
    let retryAfterSeconds;
    if (response.status === 429) {
      const header = response.headers.get('Retry-After');
      const seconds = /^[0-9]{1,9}$/.test(header ?? '')
        ? Number(header)
        : Math.ceil((Date.parse(header) - Date.now()) / 1000);
      retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.max(60, seconds) : 60;
      // Large daily/monthly cap windows stop new requests rather than looping.
      retryAfterSeconds = Math.min(retryAfterSeconds, 30 * 86400);
      blockedUntil = Date.now() + retryAfterSeconds * 1000;
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new CryptorefillsError(
        response.ok ? 502 : response.status,
        undefined,
        retryAfterSeconds,
      );
    const parts = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1e6) {
          await reader.cancel();
          throw new CryptorefillsError(502);
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    let data;
    try {
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      if (response.ok) throw new CryptorefillsError(502);
    }
    if (!response.ok) throw new CryptorefillsError(response.status, data?.code, retryAfterSeconds);
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
