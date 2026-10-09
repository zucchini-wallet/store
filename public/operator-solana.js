import { approveSolanaTopup } from './solana-topup.js';
// All dependencies are supplied by the caller. No discovery, environment reads or RPC transport.
export function createOperatorSolana({ getOrder, act, wallet, getCurrentBlockHeight }) {
  if (
    typeof getOrder !== 'function' ||
    typeof act !== 'function' ||
    typeof getCurrentBlockHeight !== 'function' ||
    !wallet
  )
    throw Error('Explicit operator dependencies required');
  let busy = false;
  return {
    async approveTopup(orderId) {
      if (busy) throw Error('Operator approval already running');
      busy = true;
      try {
        const order = await getOrder(orderId);
        if (order?.id !== orderId || order.settlement?.state !== 'topup_ready')
          throw Error('No prepared top-up; reconcile an existing attempt before retrying');
        const currentBlockHeight = await getCurrentBlockHeight(order.settlement.topupPlan);
        return await approveSolanaTopup({
          wallet,
          plan: order.settlement.topupPlan,
          currentBlockHeight,
          begin: () => act(orderId, 'begin_topup'),
          record: (txid) => act(orderId, 'submit_topup', { txid }),
        });
      } finally {
        busy = false;
      }
    },
  };
}
