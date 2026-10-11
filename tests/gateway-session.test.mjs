import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createPublicKey, verify } from 'node:crypto';
import { createGatewaySession, readGatewayJson } from '../src/gateway-session.mjs';
const seed = Buffer.alloc(32, 7).toString('base64url');
const id = '00000000-0000-4000-8000-000000000001';
function mock(transform = (x) => x) {
  let time = 1800000000,
    calls = [],
    key,
    challenge;
  const session = createGatewaySession({
    origin: 'https://gateway.example',
    installationSeed: seed,
    appId: 'store.example',
    now: () => time,
    fetcher: async (url, options) => {
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      calls.push({ url: url.href, body });
      if (url.pathname === '/v1/auth/challenges') {
        assert.equal(body.platform, 'web');
        key = body.installationPublicKey;
        challenge = {
          challengeId: id,
          challenge: Buffer.alloc(32, 9).toString('base64url'),
          expiresAt: time + 300,
        };
        challenge.message = `zucchini-gateway-session:v1\nchallenge-id:${id}\nchallenge:${challenge.challenge}\nplatform:web\napp-id:store.example\napp-version:0.1.0\nexpires-at:${challenge.expiresAt}`;
        return Response.json(transform(challenge));
      }
      assert.equal(url.pathname, '/v1/auth/sessions');
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: key },
        format: 'jwk',
      });
      assert.equal(body.challengeId, id);
      assert.equal(
        verify(
          null,
          Buffer.from(challenge.message),
          publicKey,
          Buffer.from(body.signature, 'base64url'),
        ),
        true,
      );
      return Response.json({
        token: Buffer.alloc(32, calls.length).toString('base64url'),
        session: {
          platform: 'web',
          appId: 'store.example',
          appVersion: '0.1.0',
          expiresAt: time + 900,
        },
      });
    },
  });
  return {
    session,
    calls,
    advance: (n) => {
      time += n;
    },
  };
}
test('gateway session renews with the same server identity and deduplicates concurrent renewals', async () => {
  const m = mock();
  const tokens = await Promise.all([m.session.token(), m.session.token(), m.session.token()]);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(m.calls.length, 2);
  assert.equal(await m.session.token(), tokens[0]);
  assert.equal(m.calls.length, 2);
  m.advance(871);
  assert.notEqual(await m.session.token(), tokens[0]);
  assert.equal(m.calls.length, 4);
  assert.equal(m.calls[0].body.installationPublicKey, m.calls[2].body.installationPublicKey);
  m.session.invalidate();
  await m.session.token();
  assert.equal(m.calls.length, 6);
  assert.ok(!JSON.stringify(m.calls).includes(seed));
});
test('gateway challenge signing rejects different identities, noncanonical messages and expired windows', async () => {
  for (const transform of [
    (c) => ({ ...c, message: c.message + '\n' }),
    (c) => ({ ...c, message: c.message.replace('store.example', 'other.example') }),
    (c) => ({ ...c, expiresAt: c.expiresAt + 1000 }),
    (c) => ({ ...c, challengeId: '../wrong' }),
    (c) => ({ ...c, challenge: 'invalid' }),
  ]) {
    const m = mock(transform);
    await assert.rejects(m.session.token());
    assert.equal(m.calls.length, 1);
  }
});
test('gateway JSON transport bounds streamed bytes and hides upstream error messages', async () => {
  await assert.rejects(
    readGatewayJson(new Response('private upstream detail', { status: 401 })),
    (e) => e.status === 401 && !e.message.includes('private'),
  );
  await assert.rejects(readGatewayJson(new Response('a'.repeat(200)), 100), /too large/);
  await assert.rejects(readGatewayJson(new Response('{')), /Invalid/);
});
