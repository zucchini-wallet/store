import { base58, base64 } from '@scure/base';
import {
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  compileTransactionMessage,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
} from '@solana-program/token';
export const SOLANA_USDC = Object.freeze({
  network: 'sol',
  chain: 'solana:mainnet',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  program: TOKEN_PROGRAM_ADDRESS,
  genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
});
const demand = (ok, message) => {
  if (!ok) throw Error(message);
};
const integer = (v) =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
export function isSolanaSignature(value) {
  try {
    return typeof value === 'string' && value.length <= 90 && base58.decode(value).length === 64;
  } catch {
    return false;
  }
}
export function tokenAccount(info, owner) {
  address(owner);
  demand(
    info?.owner === SOLANA_USDC.program &&
      info.executable === false &&
      info.data?.program === 'spl-token' &&
      info.data.parsed?.type === 'account',
    'Wrong token program/account',
  );
  const value = info.data.parsed.info;
  demand(
    value.owner === owner &&
      value.mint === SOLANA_USDC.mint &&
      value.state === 'initialized' &&
      value.tokenAmount?.decimals === 6 &&
      integer(value.tokenAmount.amount),
    'Wrong USDC token account owner, mint, state or decimals',
  );
  return value;
}
// Pure verification of finalized RPC evidence; callers own transport. Never reads credentials or broadcasts.
export function verifySolanaTransferEvidence(
  bundle,
  { txid, to, from, amountAtomic, sourceAccount, destinationAccount },
) {
  demand(
    isSolanaSignature(txid) && integer(amountAtomic) && BigInt(amountAtomic) > 0n,
    'Invalid Solana transfer reference',
  );
  address(to);
  if (from) address(from);
  const { genesisHash, status, transaction: tx, finalizedSlot } = bundle;
  demand(genesisHash === SOLANA_USDC.genesisHash, 'Wrong Solana network');
  demand(
    status?.confirmationStatus === 'finalized' &&
      status.err === null &&
      Number.isSafeInteger(status.slot) &&
      tx?.slot === status.slot &&
      Number.isSafeInteger(finalizedSlot) &&
      tx.slot <= finalizedSlot,
    'Transfer is not finalized',
  );
  demand(
    tx.meta?.err === null && tx.transaction?.signatures?.[0] === txid,
    'Wrong or unsuccessful transaction',
  );
  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === 'string' ? k : k.pubkey,
  );
  keys.forEach(address);
  const instructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  const balances = tx.meta.postTokenBalances ?? [];
  const validBalance = (index, owner) =>
    balances.find(
      (b) =>
        b.accountIndex === index &&
        b.mint === SOLANA_USDC.mint &&
        b.owner === owner &&
        b.programId === SOLANA_USDC.program &&
        b.uiTokenAmount?.decimals === 6 &&
        integer(b.uiTokenAmount.amount),
    );
  const candidates = instructions.filter((i) => {
    const p = i.parsed;
    if (
      i.programId !== SOLANA_USDC.program ||
      i.program !== 'spl-token' ||
      p?.type !== 'transferChecked'
    )
      return false;
    const v = p.info;
    if (
      v.mint !== SOLANA_USDC.mint ||
      v.tokenAmount?.decimals !== 6 ||
      v.tokenAmount?.amount !== amountAtomic
    )
      return false;
    const target = keys.indexOf(v.destination),
      source = keys.indexOf(v.source);
    const targetBalance = validBalance(target, to);
    const sourceBalance = balances.find((b) => b.accountIndex === source);
    if (
      !targetBalance ||
      !sourceBalance ||
      sourceBalance.mint !== SOLANA_USDC.mint ||
      sourceBalance.programId !== SOLANA_USDC.program ||
      sourceBalance.uiTokenAmount?.decimals !== 6
    )
      return false;
    if (
      from &&
      (sourceBalance.owner !== from ||
        v.authority !== from ||
        !tx.transaction.message.accountKeys.some(
          (k) => typeof k === 'object' && k.pubkey === from && k.signer === true,
        ))
    )
      return false;
    if (destinationAccount && v.destination !== destinationAccount) return false;
    if (sourceAccount && v.source !== sourceAccount) return false;
    const pre = (tx.meta.preTokenBalances ?? []).find((b) => b.accountIndex === target);
    if (
      pre &&
      (pre.owner !== to ||
        pre.mint !== SOLANA_USDC.mint ||
        pre.programId !== SOLANA_USDC.program ||
        pre.uiTokenAmount?.decimals !== 6 ||
        !integer(pre.uiTokenAmount.amount))
    )
      return false;
    // A transfer followed by draining the same account is not a credited settlement.
    if (
      BigInt(targetBalance.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0') !==
      BigInt(amountAtomic)
    )
      return false;
    return true;
  });
  demand(candidates.length === 1, 'USDC transfer missing, drained, wrong owner/mint or ambiguous');
  const info = candidates[0].parsed.info;
  return {
    canonical: true,
    confirmed: true,
    network: 'sol',
    token: SOLANA_USDC.asset,
    txid,
    recipient: to,
    to,
    from: from ?? balances.find((b) => b.accountIndex === keys.indexOf(info.source)).owner,
    sourceAccount: info.source,
    destinationAccount: info.destination,
    amountAtomic,
    slot: tx.slot,
    logIndex: String(instructions.indexOf(candidates[0])),
  };
}
// Offline unsigned TransferChecked. Requires already-existing validated associated token accounts.
export async function prepareSolanaUsdcTopup(inputs) {
  demand(
    integer(inputs.amountAtomic) && BigInt(inputs.amountAtomic) >= 10000000n,
    'Minimum provider top-up is 10 USDC',
  );
  return prepareSolanaUsdcPayment(inputs);
}

// Per-order provider payment: commercial minimums belong to the provider quote.
export async function prepareSolanaUsdcPayment({
  from,
  to,
  amountAtomic,
  sourceAccountInfo,
  destinationAccountInfo,
  latestBlockhash,
  feeLamports,
  maxFeeLamports,
  maxRentLamports,
  solBalanceLamports,
  genesisHash,
}) {
  demand(genesisHash === SOLANA_USDC.genesisHash, 'Wrong Solana network');
  demand(
    integer(maxFeeLamports) &&
      BigInt(maxFeeLamports) > 0n &&
      integer(feeLamports) &&
      BigInt(feeLamports) <= BigInt(maxFeeLamports) &&
      maxRentLamports === '0',
    'Explicit fee cap and zero-rent existing-account policy required',
  );
  demand(integer(amountAtomic) && BigInt(amountAtomic) > 0n, 'Positive USDC payment required');
  const owner = address(from),
    recipient = address(to),
    mint = address(SOLANA_USDC.mint),
    program = address(SOLANA_USDC.program);
  const source = tokenAccount(sourceAccountInfo, from);
  tokenAccount(destinationAccountInfo, to);
  demand(BigInt(source.tokenAmount.amount) >= BigInt(amountAtomic), 'Insufficient USDC');
  demand(
    integer(feeLamports) &&
      BigInt(feeLamports) > 0n &&
      integer(solBalanceLamports) &&
      BigInt(solBalanceLamports) >= BigInt(feeLamports),
    'Fee payer needs sufficient SOL',
  );
  demand(
    Number.isSafeInteger(latestBlockhash.lastValidBlockHeight) &&
      latestBlockhash.lastValidBlockHeight > 0,
    'Missing blockhash validity',
  );
  const [sourceAddress] = await findAssociatedTokenPda({ owner, tokenProgram: program, mint });
  const [destinationAddress] = await findAssociatedTokenPda({
    owner: recipient,
    tokenProgram: program,
    mint,
  });
  demand(
    sourceAccountInfo.address === sourceAddress &&
      destinationAccountInfo.address === destinationAddress,
    'Token-account evidence does not match derived associated accounts',
  );
  const instruction = getTransferCheckedInstruction({
    source: sourceAddress,
    mint,
    destination: destinationAddress,
    authority: createNoopSigner(owner),
    amount: BigInt(amountAtomic),
    decimals: 6,
  });
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(owner, message);
  message = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash(latestBlockhash.blockhash),
      lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
    },
    message,
  );
  message = appendTransactionMessageInstructions([instruction], message);
  const bytes = getTransactionEncoder().encode(compileTransaction(message));
  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(message),
  );
  return {
    token: SOLANA_USDC.asset,
    network: 'sol',
    chain: SOLANA_USDC.chain,
    from,
    to,
    amountAtomic,
    sourceAccount: sourceAddress,
    destinationAccount: destinationAddress,
    feePayer: from,
    feeLamports,
    maxFeeLamports,
    maxRentLamports,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    transactionBase64: Buffer.from(bytes).toString('base64'),
    messageBase64: Buffer.from(messageBytes).toString('base64'),
  };
}

// Decode and reconstruct exactly the authorized single unsigned transfer. No transport or credentials.
export async function validateSolanaTopupPlan(plan, expected = plan) {
  demand(
    plan.network === 'sol' && plan.chain === SOLANA_USDC.chain && plan.token === SOLANA_USDC.asset,
    'Wrong top-up asset/network',
  );
  for (const field of ['from', 'to', 'amountAtomic'])
    demand(plan[field] === expected[field], 'Bound top-up field changed');
  demand(
    integer(plan.amountAtomic) && BigInt(plan.amountAtomic) > 0n && plan.feePayer === plan.from,
    'Invalid top-up amount/payer',
  );
  demand(
    integer(plan.feeLamports) &&
      BigInt(plan.feeLamports) > 0n &&
      Number.isSafeInteger(plan.lastValidBlockHeight) &&
      plan.lastValidBlockHeight > 0,
    'Missing fee/lifetime policy',
  );
  demand(
    integer(plan.maxFeeLamports) &&
      BigInt(plan.maxFeeLamports) > 0n &&
      BigInt(plan.feeLamports) <= BigInt(plan.maxFeeLamports) &&
      plan.maxRentLamports === '0',
    'Explicit fee/rent cap required',
  );
  const bytes = base64.decode(plan.transactionBase64);
  const tx = getTransactionDecoder().decode(bytes);
  demand(
    Object.values(tx.signatures).every((v) => v === null),
    'Top-up must be unsigned',
  );
  const decoded = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  demand(decoded.version === 'legacy', 'Unsupported transaction version');
  const mint = address(SOLANA_USDC.mint),
    tokenProgram = address(SOLANA_USDC.program);
  const [source] = await findAssociatedTokenPda({ owner: address(plan.from), mint, tokenProgram });
  const [destination] = await findAssociatedTokenPda({
    owner: address(plan.to),
    mint,
    tokenProgram,
  });
  demand(
    plan.sourceAccount === source && plan.destinationAccount === destination,
    'Wrong associated accounts',
  );
  let message = createTransactionMessage({ version: 'legacy' });
  message = setTransactionMessageFeePayer(address(plan.from), message);
  message = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash(decoded.lifetimeToken),
      lastValidBlockHeight: BigInt(plan.lastValidBlockHeight),
    },
    message,
  );
  message = appendTransactionMessageInstructions(
    [
      getTransferCheckedInstruction({
        source,
        mint,
        destination,
        authority: createNoopSigner(address(plan.from)),
        amount: BigInt(plan.amountAtomic),
        decimals: 6,
      }),
    ],
    message,
  );
  const canonical = getTransactionEncoder().encode(compileTransaction(message));
  demand(
    bytes.length === canonical.length && bytes.every((v, i) => v === canonical[i]),
    'Serialized transaction differs from bound TransferChecked plan',
  );
  demand(base64.encode(tx.messageBytes) === plan.messageBase64, 'Message serialization mismatch');
  return true;
}
