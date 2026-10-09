import { matchesPaymentMemo } from './payment-memo.mjs';
export function reconcileBatch(state, batch, birthday, observedAt) {
  if (batch.network !== state.network || !Array.isArray(batch.blocks))
    throw Error('Scanner network changed');
  const start = batch.blocks[0]?.height ?? state.scannedHeight + 1;
  if (start > state.scannedHeight + 1) throw Error('Scan skipped blocks');
  const previous = state.blocks.find((b) => b.height === start - 1);
  if (previous && previous.hash !== batch.anchorHash)
    return {
      ...state,
      blocks: [],
      scannedHeight: birthday - 1,
      tipHeight: batch.tipHeight,
      tipHash: batch.tipHash,
      caughtUp: false,
    };
  const blocks = state.blocks.filter((b) => b.height < start);
  let expected = start,
    hash = batch.anchorHash;
  for (const block of batch.blocks) {
    if (block.height !== expected++ || block.previousHash !== hash)
      throw Error('Non-canonical scan');
    hash = block.hash;
    blocks.push(block);
  }
  const scanned = blocks.at(-1)?.height ?? birthday - 1;
  if (scanned > batch.tipHeight || (scanned === batch.tipHeight && hash !== batch.tipHash))
    throw Error('Invalid scan tip');
  const seen = { ...state.seen };
  for (const b of blocks)
    for (const r of b.receipts) seen[`${r.txid}/${r.pool}/${r.outputIndex}`] ??= observedAt;
  return {
    ...state,
    blocks,
    seen,
    scannedHeight: scanned,
    tipHeight: batch.tipHeight,
    tipHash: batch.tipHash,
    caughtUp: scanned === batch.tipHeight,
    observedAt,
  };
}
export function snapshotFor(state, order) {
  return {
    version: 1,
    sequence: state.sequence,
    network: state.network,
    observedAt: state.observedAt,
    tipHeight: state.tipHeight,
    tipHash: state.tipHash,
    scannedHeight: state.scannedHeight,
    receipts: state.blocks
      .flatMap((b) => b.receipts)
      .filter((r) => r.recipient === order.recipient && matchesPaymentMemo(r, order))
      .map((r) => ({ ...r, receivedAt: state.seen[`${r.txid}/${r.pool}/${r.outputIndex}`] })),
  };
}
