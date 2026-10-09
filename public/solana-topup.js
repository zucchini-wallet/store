import { validateSolanaTopupPlan } from '../src/solana-settlement.mjs';
import { base58 } from '@scure/base';
// Wallet Standard approval only. No private keys, RPC transport or automatic retries.
export async function approveSolanaTopup({ wallet, plan, begin, record, currentBlockHeight }) {
  if (
    plan.network !== 'sol' ||
    plan.chain !== 'solana:mainnet' ||
    !plan.transactionBase64 ||
    !Number.isSafeInteger(currentBlockHeight) ||
    currentBlockHeight > plan.lastValidBlockHeight
  )
    throw Error('Solana top-up plan is missing or expired');
  await validateSolanaTopupPlan(plan);
  const feature = wallet?.features?.['solana:signAndSendTransaction'];
  const connect = wallet?.features?.['standard:connect'];
  if (!feature?.signAndSendTransaction || !connect?.connect)
    throw Error('Selected wallet cannot approve a Solana transfer');
  const { accounts } = await connect.connect();
  const account = accounts.find(
    (a) => a.address === plan.from && a.chains.includes('solana:mainnet'),
  );
  if (!account) throw Error('Select the exact merchant buffer account on Solana mainnet');
  const bytes = Uint8Array.from(atob(plan.transactionBase64), (c) => c.charCodeAt(0));
  await begin(); // Persist signing state BEFORE asking the wallet. Never repeat after ambiguity.
  const results = await feature.signAndSendTransaction({
    account,
    chain: 'solana:mainnet',
    transaction: bytes,
    options: { preflightCommitment: 'finalized' },
  });
  if (
    results.length !== 1 ||
    !(results[0].signature instanceof Uint8Array) ||
    results[0].signature.length !== 64
  )
    throw Error('Uncertain wallet submission; reconcile before retrying');
  const txid = base58.encode(results[0].signature);
  await record(txid);
  return txid;
}
