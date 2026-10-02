import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
export class ProviderError extends Error {
  constructor(status) {
    super('Gift-card provider is temporarily unavailable.');
    this.status = status;
  }
}
export function createProvider(config, { fetcher = fetch, now = Date.now } = {}) {
  return {
    describeError(error) {
      return String(error?.message ?? 'Connection failed')
        .replaceAll(config.API_KEY, '[redacted]')
        .replaceAll(config.API_SECRET, '[redacted]')
        .slice(0, 200);
    },
    async request(path, body) {
      const payload = Buffer.from(JSON.stringify({ timestamp: now(), body: body ?? {} })).toString(
        'base64',
      );
      const response = await fetcher('https://api.0fiat.com/0fiat/api/v2/whitelabel' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json',
          'x-0fiat-apikey': config.API_KEY,
          'x-0fiat-payload': payload,
          'x-0fiat-signature': createHmac('sha512', config.API_SECRET)
            .update(payload)
            .digest('hex'),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
        redirect: 'manual',
      });
      if (!response.ok) throw new ProviderError(response.status);
      const text = await response.text();
      if (text.length > 5e6) throw new ProviderError(502);
      const data = JSON.parse(text).data;
      if (!data || typeof data !== 'object') throw new ProviderError(502);
      return data;
    },
  };
}
export function providerState(value) {
  const s = value?.status;
  if (s === 6 || s === 'succeeded') return 'succeeded';
  if (s === -2 || s === 'failed') return 'failed';
  if (s === -6 || s === 'refunded') return 'refunded';
  if ([0, 1, 2, 3, 4, 5, 'pending', 'processing'].includes(s)) return 'processing';
  throw new ProviderError(502);
}
