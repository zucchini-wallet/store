import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyOutgoingZcashEvidence } from '../src/zcash-outgoing-evidence.mjs';
test('outgoing confirmation contract rejects incoming-only, stale, reorged or mismatched evidence', () => {
  const expected = {
    accountId: 'merchant-account',
    network: 'mainnet',
    txid: 'a'.repeat(64),
    recipient: 'validated-shielded-recipient',
    amountZatoshis: '1000',
    memo: 'private-recovery-link',
  };
  const evidence = {
    ...expected,
    source: 'account_scoped_outgoing',
    canonical: true,
    confirmed: true,
    observedAt: 1000,
    blockHeight: 90,
    tipHeight: 100,
    blockHash: 'b'.repeat(64),
  };
  const policy = { confirmations: 10, now: 1000 };
  assert.equal(verifyOutgoingZcashEvidence(evidence, expected, policy).confirmed, true);
  for (const patch of [
    { source: 'incoming_scanner' },
    { accountId: 'other' },
    { network: 'testnet' },
    { txid: 'c'.repeat(64) },
    { recipient: 'other' },
    { amountZatoshis: '999' },
    { memo: 'other' },
    { canonical: false },
    { confirmed: false },
    { observedAt: 900 },
    { observedAt: 1001 },
    { tipHeight: 95 },
    { blockHash: '' },
  ])
    assert.throws(() => verifyOutgoingZcashEvidence({ ...evidence, ...patch }, expected, policy));
});
