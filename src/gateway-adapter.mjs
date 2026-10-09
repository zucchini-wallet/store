// Uses an existing merchant installation session; never signs, derives keys, or retries quotes.
export function createGatewayAdapter({ origin, session, config, fetcher = fetch }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw Error('Invalid gateway origin');
  async function request(path, body) {
    const token = await session();
    if (typeof token !== 'string' || token.length < 32)
      throw Error('Merchant gateway session unavailable');
    const response = await fetcher(new URL('/v1/swaps/' + path, base), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
    });
    if (!response.ok) throw Error('Gateway request unavailable; reconcile before retrying');
    const text = await response.text();
    if (text.length > 512000) throw Error('Gateway response too large');
    return JSON.parse(text);
  }
  return {
    async quote(order) {
      const q = await request('quotes', {
        amountAtomic: order.amountZatoshis,
        originAssetId: 'nep141:zec.omft.near',
        destinationAssetId: config.settlementAsset,
        recipientAddress: config.bufferAddress,
        refundAddress: config.conversionRefundAddress,
        slippageBps: config.slippageBps ?? 100,
        mode: 'execution',
      });
      if (
        q.mode !== 'execution' ||
        q.integrity !== 'provider_signature_verified' ||
        !q.orderId ||
        !q.quote?.deposit
      )
        throw Error('Unverified gateway quote');
      return {
        orderId: q.orderId,
        originAsset: q.originAsset,
        destinationAsset: q.destinationAsset,
        recipientAddress: config.bufferAddress,
        refundAddress: config.conversionRefundAddress,
        amountInAtomic: q.quote.amountInAtomic,
        minimumOutputAtomic: q.quote.minimumAmountOutAtomic,
        depositAddress: q.quote.deposit.address,
        memo: q.quote.deposit.memo,
        deadline: Date.parse(q.quote.deposit.deadline) / 1000,
        signatureVerified: true,
      };
    },
    notifyDeposit: (_order, q, txid) =>
      request('deposits', { orderId: q.orderId, transactionHash: txid }),
    conversionStatus: (_order, s) => request('status', { orderId: s.quote.orderId }),
  };
}
