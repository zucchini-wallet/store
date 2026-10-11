import { gatewayOrigin, readGatewayJson } from './gateway-session.mjs';
import { SOLANA_USDC } from './solana-settlement.mjs';
const ZEC_ASSET = 'nep141:zec.omft.near';
const demand = (ok, message) => {
  if (!ok) throw Error(message);
};
export function createDirectGatewayAdapter({
  origin,
  session,
  slippageBps = 100,
  fetcher = fetch,
}) {
  const base = gatewayOrigin(origin);
  async function request(path, body) {
    const token = await session.token();
    const r = await fetcher(new URL('/v1/swaps/' + path, base), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    if (r.status === 401) session.invalidate();
    // A transport error or expired auth never replays an execution quote.
    return readGatewayJson(r);
  }
  function normalize(q, input) {
    const r = q?.request;
    demand(
      q?.provider === 'near_one_click' &&
        q.mode === 'execution' &&
        q.integrity === 'provider_signature_verified' &&
        q.swapType === 'EXACT_OUTPUT' &&
        q.originAsset === ZEC_ASSET &&
        q.destinationAsset === SOLANA_USDC.asset &&
        r?.clientRequestId === input.clientRequestId &&
        r.swapType === 'EXACT_OUTPUT' &&
        r.mode === 'execution' &&
        r.originAssetId === ZEC_ASSET &&
        r.destinationAssetId === SOLANA_USDC.asset &&
        r.amountAtomic === input.amountAtomic &&
        r.recipientAddress === input.recipientAddress &&
        r.refundAddress === input.refundAddress &&
        r.slippageBps === slippageBps &&
        r.deadlineEpochSeconds === input.deadlineEpochSeconds,
      'Gateway quote differs from bound exact-output request',
    );
    const d = q.quote?.deposit,
      raw = d?.deadline;
    demand(
      typeof raw === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw),
      'Invalid gateway deposit deadline',
    );
    const deadline = Math.floor(Date.parse(raw) / 1000);
    demand(
      Number.isSafeInteger(deadline) && deadline <= input.deadlineEpochSeconds,
      'Gateway deposit deadline exceeds invoice window',
    );
    demand(
      q.quote.amountOutAtomic === input.amountAtomic &&
        q.quote.minimumAmountOutAtomic === input.amountAtomic,
      'Gateway exact output changed',
    );
    return {
      orderId: q.orderId,
      providerQuoteId: q.providerQuoteId,
      providerSignature: q.providerSignature,
      mode: q.mode,
      integrity: q.integrity,
      swapType: q.swapType,
      originAsset: q.originAsset,
      destinationAsset: q.destinationAsset,
      recipientAddress: r.recipientAddress,
      recipientType: 'DESTINATION_CHAIN',
      refundAddress: r.refundAddress,
      refundType: 'ORIGIN_CHAIN',
      amountInAtomic: q.quote.amountInAtomic,
      minimumInputAtomic: q.quote.minimumAmountInAtomic,
      amountOutAtomic: q.quote.amountOutAtomic,
      depositAddress: d.address,
      // Rust serializes Option::None as null. Omission/empty/memos fail in binding.
      depositMemo: d.memo,
      deadline,
    };
  }
  return {
    async quoteSwap(_o, input) {
      const body = {
        ...input,
        originAssetId: ZEC_ASSET,
        destinationAssetId: SOLANA_USDC.asset,
        slippageBps,
        mode: 'execution',
        swapType: 'EXACT_OUTPUT',
      };
      return normalize(await request('quotes', body), input);
    },
    async recoverSwap(_o, input) {
      const r = await request('quotes/recover', { clientRequestId: input.clientRequestId });
      demand(
        r.clientRequestId === input.clientRequestId && r.state === 'created' && r.quote,
        'Original swap quote is unavailable; no replacement payment can be requested',
      );
      return normalize(r.quote, input);
    },
    notifyDeposit: (_o, b, txid) =>
      request('deposits', { orderId: b.gatewayOrderId, transactionHash: txid }),
    swapStatus: (_o, b) => request('status', { orderId: b.gatewayOrderId }),
  };
}
