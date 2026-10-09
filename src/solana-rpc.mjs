import { base64 } from '@scure/base';
import { address, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  SOLANA_USDC,
  isSolanaSignature,
  prepareSolanaUsdcPayment,
  validateSolanaTopupPlan,
  verifySolanaTransferEvidence,
} from './solana-settlement.mjs';

const demand = (ok, message) => {
  if (!ok) throw Error(message);
};
const safeNumber = (value) => Number.isSafeInteger(value) && value >= 0;
const atomic = (value) =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,19})$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
const contextValue = (result, minimumSlot = 0) => {
  demand(
    safeNumber(result?.context?.slot) &&
      result.context.slot >= minimumSlot &&
      Object.hasOwn(result, 'value'),
    'Solana RPC context unavailable',
  );
  return result.value;
};

// Read-only JSON-RPC. The caller supplies an approved endpoint and exact payment inputs.
// This transport never loads keys, signs, creates accounts, or broadcasts transactions.
export function createSolanaRpc({
  url,
  fetcher = fetch,
  maxResponseBytes = 1000000,
  timeoutMs = 20000,
}) {
  const endpoint = new URL(url);
  demand(
    endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.hash,
    'Solana RPC requires an HTTPS endpoint',
  );
  demand(
    typeof fetcher === 'function' &&
      Number.isSafeInteger(maxResponseBytes) &&
      maxResponseBytes >= 1000 &&
      maxResponseBytes <= 2000000 &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 30000,
    'Invalid Solana RPC transport policy',
  );
  let sequence = 0;
  async function request(method, params = []) {
    const id = ++sequence;
    let response;
    try {
      response = await fetcher(endpoint.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw Error('Solana RPC unavailable');
    }
    demand(response.ok, 'Solana RPC unavailable');
    const length = response.headers.get('Content-Length');
    demand(
      length === null || (/^[0-9]+$/.test(length) && Number(length) <= maxResponseBytes),
      'Solana RPC response too large',
    );
    demand(response.body, 'Solana RPC response missing');
    const reader = response.body.getReader();
    let size = 0;
    const parts = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          throw Error('Solana RPC response too large');
        }
        parts.push(value);
      }
    } catch {
      throw Error('Solana RPC response unavailable or too large');
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw Error('Invalid Solana RPC response');
    }
    demand(
      body?.jsonrpc === '2.0' &&
        body.id === id &&
        !Object.hasOwn(body, 'error') &&
        Object.hasOwn(body, 'result'),
      'Solana RPC request failed',
    );
    return body.result;
  }
  async function genesis() {
    const hash = await request('getGenesisHash');
    demand(hash === SOLANA_USDC.genesisHash, 'Wrong Solana network');
    return hash;
  }
  async function readTransferEvidence(txid) {
    demand(isSolanaSignature(txid), 'Invalid Solana transaction signature');
    const genesisHash = await genesis();
    const [statuses, transaction, finalizedSlot] = await Promise.all([
      request('getSignatureStatuses', [[txid], { searchTransactionHistory: true }]),
      request('getTransaction', [
        txid,
        { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]),
      request('getSlot', [{ commitment: 'finalized' }]),
    ]);
    const values = contextValue(statuses);
    demand(Array.isArray(values) && values.length === 1, 'Solana status unavailable');
    demand(safeNumber(finalizedSlot), 'Finalized Solana slot unavailable');
    return { genesisHash, status: values[0], transaction, finalizedSlot };
  }
  return {
    readTransferEvidence,
    async verifyTopup(plan, txid) {
      await validateSolanaTopupPlan(plan);
      const bundle = await readTransferEvidence(txid);
      const evidence = verifySolanaTransferEvidence(bundle, {
        txid,
        from: plan.from,
        to: plan.to,
        amountAtomic: plan.amountAtomic,
        sourceAccount: plan.sourceAccount,
        destinationAccount: plan.destinationAccount,
      });
      // Parsed RPC data must match the complete persisted single-transfer message.
      // Checking only a matching transfer would also permit an added transfer or changed lifetime.
      const expected = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(base64.decode(plan.transactionBase64)).messageBytes,
      );
      const tx = bundle.transaction;
      const message = tx.transaction.message;
      demand(
        tx.version === 'legacy' &&
          tx.transaction.signatures.length === 1 &&
          message.recentBlockhash === expected.lifetimeToken &&
          message.accountKeys.length === expected.staticAccounts.length &&
          message.accountKeys.every((key, index) => {
            const signer = index < expected.header.numSignerAccounts;
            const writable = signer
              ? index <
                expected.header.numSignerAccounts - expected.header.numReadonlySignerAccounts
              : index <
                expected.staticAccounts.length - expected.header.numReadonlyNonSignerAccounts;
            return (
              key.pubkey === expected.staticAccounts[index] &&
              key.signer === signer &&
              key.writable === writable
            );
          }) &&
          message.instructions.length === 1 &&
          (tx.meta.innerInstructions ?? []).every((group) => group.instructions.length === 0) &&
          safeNumber(tx.meta.fee) &&
          String(tx.meta.fee) === plan.feeLamports,
        'Confirmed Solana transaction differs from approved payment plan',
      );
      return evidence;
    },
    async preparePayment({ from, to, amountAtomic, maxFeeLamports, maxRentLamports }) {
      address(from);
      address(to);
      demand(from !== to, 'Solana payment recipient must differ from payer');
      demand(atomic(amountAtomic) && BigInt(amountAtomic) > 0n, 'Positive USDC payment required');
      demand(
        atomic(maxFeeLamports) && BigInt(maxFeeLamports) > 0n && maxRentLamports === '0',
        'Explicit fee cap and zero-rent existing-account policy required',
      );
      const genesisHash = await genesis();
      const latest = await request('getLatestBlockhash', [{ commitment: 'finalized' }]);
      const latestBlockhash = contextValue(latest);
      const minContextSlot = latest.context.slot;
      const mint = address(SOLANA_USDC.mint),
        tokenProgram = address(SOLANA_USDC.program);
      const [[source], [destination]] = await Promise.all([
        findAssociatedTokenPda({ owner: address(from), mint, tokenProgram }),
        findAssociatedTokenPda({ owner: address(to), mint, tokenProgram }),
      ]);
      const [accounts, balance] = await Promise.all([
        request('getMultipleAccounts', [
          [source, destination],
          { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot },
        ]),
        request('getBalance', [from, { commitment: 'finalized', minContextSlot }]),
      ]);
      const infos = contextValue(accounts, minContextSlot);
      const sol = contextValue(balance, minContextSlot);
      demand(
        Array.isArray(infos) && infos.length === 2 && infos.every(Boolean),
        'Existing USDC associated token accounts required',
      );
      demand(safeNumber(sol), 'Exact Solana fee-payer balance unavailable');
      const inputs = {
        from,
        to,
        amountAtomic,
        maxFeeLamports,
        maxRentLamports,
        genesisHash,
        latestBlockhash,
        sourceAccountInfo: { ...infos[0], address: source },
        destinationAccountInfo: { ...infos[1], address: destination },
        solBalanceLamports: String(sol),
      };
      // Fees are outside the serialized message. Build its bytes with a provisional
      // positive fee, then price that exact message before returning any plan.
      const provisional = await prepareSolanaUsdcPayment({ ...inputs, feeLamports: '1' });
      const fee = contextValue(
        await request('getFeeForMessage', [
          provisional.messageBase64,
          { commitment: 'finalized', minContextSlot },
        ]),
        minContextSlot,
      );
      demand(safeNumber(fee) && fee > 0, 'Solana message fee unavailable or blockhash expired');
      const plan = await prepareSolanaUsdcPayment({ ...inputs, feeLamports: String(fee) });
      await validateSolanaTopupPlan(plan, { from, to, amountAtomic });
      return plan;
    },
    async getCurrentBlockHeight() {
      await genesis();
      const height = await request('getBlockHeight', [{ commitment: 'finalized' }]);
      demand(safeNumber(height), 'Finalized Solana block height unavailable');
      return height;
    },
  };
}
