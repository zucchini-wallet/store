import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

export async function readGatewayJson(response, maxBytes = 512000) {
  if (!response.ok) {
    await response.body?.cancel();
    const e = Error('Gateway request unavailable; recover before retrying');
    e.status = response.status;
    throw e;
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Gateway response missing');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw Error('Gateway response too large');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw Error('Invalid gateway response');
  }
}

export function gatewayOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error('Invalid gateway origin');
  return url;
}

// This key identifies the store server's installation. It cannot sign transactions
// and must never be taken from a customer wallet or exposed to the browser.
export function createGatewaySession({
  origin,
  installationSeed,
  appId,
  appVersion = '0.1.0',
  fetcher = fetch,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const base = gatewayOrigin(origin);
  if (typeof installationSeed !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(installationSeed))
    throw Error('Private gateway installation seed required');
  const seed = Buffer.from(installationSeed, 'base64url');
  if (seed.length !== 32 || seed.toString('base64url') !== installationSeed)
    throw Error('Invalid gateway installation seed');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(appId ?? '') || !/^[A-Za-z0-9._+\-]{1,64}$/.test(appVersion))
    throw Error('Invalid gateway application identity');
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(key).export({ format: 'jwk' }).x;
  let cached, renewing;
  async function post(path, body) {
    return readGatewayJson(
      await fetcher(new URL('/v1/auth/' + path, base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      }),
      16000,
    );
  }
  async function renew() {
    const c = await post('challenges', {
      platform: 'web',
      appId,
      appVersion,
      installationPublicKey: publicKey,
    });
    if (
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(c.challengeId ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(c.challenge ?? '') ||
      !Number.isSafeInteger(c.expiresAt) ||
      c.expiresAt <= now() ||
      c.expiresAt > now() + 600
    )
      throw Error('Invalid gateway authentication challenge');
    const expected = `zucchini-gateway-session:v1\nchallenge-id:${c.challengeId}\nchallenge:${c.challenge}\nplatform:web\napp-id:${appId}\napp-version:${appVersion}\nexpires-at:${c.expiresAt}`;
    if (c.message !== expected) throw Error('Gateway authentication challenge changed identity');
    const signature = sign(null, Buffer.from(expected), key).toString('base64url');
    const s = await post('sessions', { challengeId: c.challengeId, signature });
    if (
      s.session?.platform !== 'web' ||
      s.session.appId !== appId ||
      s.session.appVersion !== appVersion ||
      !Number.isSafeInteger(s.session.expiresAt) ||
      s.session.expiresAt <= now() + 30 ||
      s.session.expiresAt > now() + 86400 ||
      typeof s.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(s.token)
    )
      throw Error('Invalid gateway session response');
    cached = { token: s.token, expiresAt: s.session.expiresAt };
    return cached.token;
  }
  return {
    publicKey,
    invalidate() {
      cached = undefined;
    },
    async token() {
      if (cached && now() + 30 < cached.expiresAt) return cached.token;
      if (!renewing)
        renewing = renew().finally(() => {
          renewing = undefined;
        });
      return renewing;
    },
  };
}
