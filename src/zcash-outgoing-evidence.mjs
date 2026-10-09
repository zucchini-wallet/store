// Pure outgoing-wallet evidence contract. Incoming viewing-key scans do not satisfy this contract.
// A future adapter must obtain these fields from account-scoped wallet/chain data, never a browser claim.
export function verifyOutgoingZcashEvidence(
  evidence,
  expected,
  { confirmations, now, maxAgeSeconds = 90 },
) {
  const fail = () => {
    throw Error('Unverified outgoing Zcash transfer');
  };
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || !Number.isSafeInteger(now))
    fail();
  if (
    !evidence ||
    evidence.source !== 'account_scoped_outgoing' ||
    evidence.accountId !== expected.accountId ||
    !expected.accountId ||
    evidence.network !== expected.network ||
    evidence.txid !== expected.txid ||
    !/^[a-f0-9]{64}$/i.test(evidence.txid ?? '') ||
    evidence.recipient !== expected.recipient ||
    evidence.amountZatoshis !== expected.amountZatoshis ||
    !/^[1-9][0-9]*$/.test(evidence.amountZatoshis ?? '') ||
    evidence.memo !== expected.memo ||
    evidence.canonical !== true ||
    evidence.confirmed !== true
  )
    fail();
  if (
    !Number.isSafeInteger(evidence.observedAt) ||
    evidence.observedAt > now ||
    now - evidence.observedAt > maxAgeSeconds ||
    !Number.isSafeInteger(evidence.blockHeight) ||
    evidence.blockHeight < 1 ||
    !Number.isSafeInteger(evidence.tipHeight) ||
    evidence.tipHeight - evidence.blockHeight + 1 < confirmations ||
    !/^[a-f0-9]{64}$/i.test(evidence.blockHash ?? '')
  )
    fail();
  return Object.freeze({ ...evidence });
}
