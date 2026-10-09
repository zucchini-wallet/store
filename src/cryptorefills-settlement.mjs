import Decimal from 'decimal.js';
import { address } from '@solana/kit';
import { validateSolanaTopupPlan, isSolanaSignature, SOLANA_USDC } from './solana-settlement.mjs';
import { reconcile } from './domain.mjs';
const demand = (ok, message) => {
  if (!ok) throw Error(message);
};

// Provider adapters fetch authoritative responses and normalize the reviewed v6 schema.
// prepareTopup and verifyTopup reuse the existing Solana builder/evidence verifier.
export function createCryptorefillsSettlement({
  store,
  config,
  adapters,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const busy = new Set();
  async function act(id, action, input = {}) {
    demand(!busy.has(id), 'Settlement action already running');
    busy.add(id);
    try {
      const o = store.get(id),
        s = o?.settlement;
      demand(
        o?.giftCardProvider === 'cryptorefills' && o.fundingMode === 'shielded_buffer',
        'Not a Cryptorefills buffered order',
      );
      demand(adapters, 'Cryptorefills response adapters unavailable');
      demand(['payment_pending', 'fulfilling'].includes(o.state), 'Order requires review');
      const active = () =>
        demand(
          store.get(id)?.state === o.state,
          'Order changed while external evidence was fetched',
        );
      const fresh = () =>
        demand(
          reconcile(store.get(id), store.get(id).snapshot, now(), config.confirmations).canFulfill,
          'Canonical receipt changed during preparation',
        );
      if (action === 'prepare_topup') {
        demand(
          ['buffer_confirmed', 'provider_order_requested'].includes(s?.state),
          'Confirmed buffer funds required',
        );
        demand(
          reconcile(o, o.snapshot, now(), config.confirmations).canFulfill,
          'Fresh canonical ZEC receipt required',
        );
        demand(adapters.createOrder && adapters.prepareTopup, 'Payment adapters unavailable');
        // Persist before POST. Recovery retries the SAME external_order_id only.
        store.update(id, (r) => {
          r.settlement = { ...s, state: 'provider_order_requested' };
        });
        const p = await adapters.createOrder(store.get(id));
        active();
        fresh();
        demand(
          p.externalOrderId === id &&
            typeof p.orderId === 'string' &&
            p.orderId.length > 0 &&
            p.orderId.length <= 128,
          'Provider order identity mismatch',
        );
        demand(!o.providerOrderId || o.providerOrderId === p.orderId, 'Provider order changed');
        demand(
          p.coin === 'USDC' &&
            p.network === 'Solana' &&
            p.state === 'WAITING_FOR_PAYMENT' &&
            Number.isSafeInteger(p.expiresAt) &&
            p.expiresAt > now(),
          'Provider payment window unavailable',
        );
        if (o.providerPayment)
          for (const field of [
            'orderId',
            'externalOrderId',
            'coin',
            'network',
            'recipient',
            'amountAtomic',
            'expiresAt',
          ])
            demand(
              o.providerPayment[field] === p[field],
              'Provider payment changed during recovery',
            );
        address(p.recipient);
        demand(/^[1-9][0-9]*$/.test(p.amountAtomic ?? ''), 'Invalid provider amount');
        demand(
          new Decimal(p.amountAtomic).lte(new Decimal(o.costUsd).mul(1e6)),
          'Provider price exceeds authorized cost',
        );
        demand(
          new Decimal(s.bufferReceipt?.amountAtomic ?? 0).gte(
            new Decimal(p.amountAtomic).plus(
              new Decimal(config.minimumRetainedMarginUsd ?? 0).mul(1e6),
            ),
          ),
          'Insufficient buffer output',
        );
        demand(
          !store.all().some((r) => r.id !== id && r.providerOrderId === p.orderId),
          'Provider order already assigned',
        );
        store.update(id, (r) => {
          r.providerOrderId = p.orderId;
          r.providerPayment = p;
        });
        const plan = await adapters.prepareTopup(store.get(id), { ...s, providerPayment: p });
        demand(
          config.settlementNetwork === 'sol' &&
            config.settlementAsset === SOLANA_USDC.asset &&
            plan.network === 'sol' &&
            plan.token === SOLANA_USDC.asset &&
            plan.maxFeeLamports === config.solanaMaxFeeLamports &&
            plan.maxRentLamports === config.solanaMaxRentLamports,
          'Solana policy mismatch',
        );
        await validateSolanaTopupPlan(plan, {
          from: config.bufferAddress,
          to: p.recipient,
          amountAtomic: p.amountAtomic,
        });
        active();
        fresh();
        demand(p.expiresAt > now(), 'Provider payment expired during preparation');
        store.update(id, (r) => {
          r.settlement = { ...s, state: 'topup_ready', topupPlan: plan };
        });
      } else if (action === 'begin_topup') {
        demand(
          s.state === 'topup_ready' &&
            o.providerPayment.expiresAt > now() &&
            reconcile(o, o.snapshot, now(), config.confirmations).canFulfill,
          'Provider payment expired or receipt requires review',
        );
        store.update(id, (r) => {
          r.settlement = { ...s, state: 'topup_signing' };
        });
      } else if (action === 'submit_topup') {
        demand(
          ['topup_signing', 'topup_submitted'].includes(s.state) && isSolanaSignature(input.txid),
          'Invalid payment submission',
        );
        demand(!s.topupTxid || s.topupTxid === input.txid, 'Payment transaction changed');
        store.update(id, (r) => {
          r.settlement = { ...s, state: 'topup_submitted', topupTxid: input.txid };
        });
      } else if (action === 'check_topup') {
        demand(
          s.state === 'topup_submitted' && adapters.verifyTopup,
          'Payment verification unavailable',
        );
        const e = await adapters.verifyTopup(o, s),
          p = o.providerPayment;
        demand(
          e.confirmed &&
            e.canonical &&
            e.txid === s.topupTxid &&
            e.token === SOLANA_USDC.asset &&
            e.network === 'sol' &&
            e.from === config.bufferAddress &&
            e.to === p.recipient &&
            e.amountAtomic === p.amountAtomic,
          'Unverified provider payment',
        );
        demand(
          !store.all().some((r) => r.id !== id && r.settlement?.topupTxid === e.txid),
          'Payment already assigned',
        );
        active();
        store.update(id, (r) => {
          r.state = 'fulfilling';
          r.settlement = { ...s, state: 'provider_paid', topupReceipt: e };
        });
      } else if (action === 'check_delivery') {
        demand(
          s.state === 'provider_paid' && adapters.getOrder,
          'Provider status adapter unavailable',
        );
        const p = await adapters.getOrder(o);
        active();
        demand(
          p.orderId === o.providerOrderId && p.externalOrderId === id,
          'Wrong provider status',
        );
        if (p.state === 'COMPLETED') {
          demand(
            p.delivery?.beneficiary === o.email &&
              p.delivery?.brand === o.brand &&
              p.delivery?.country === o.country &&
              p.delivery?.faceAmount === o.faceAmount &&
              p.delivery?.card &&
              typeof p.delivery.card === 'object' &&
              !Array.isArray(p.delivery.card) &&
              Object.keys(p.delivery.card).length > 0,
            'Delivery evidence missing or mismatched',
          );
          store.update(id, (r) => {
            r.card = p.delivery.card;
            r.state = 'delivered';
            r.deliveredAt = now();
          });
        } else if (
          [
            'EXPIRED',
            'CANCELED',
            'CANCELLED',
            'REFUNDED',
            'PAYMENT_FAILED',
            'MANUAL_REVIEW',
          ].includes(p.state)
        ) {
          store.update(id, (r) => {
            r.state = 'refund_review';
            r.reason = 'cryptorefills_' + p.state.toLowerCase();
          });
        } else if (
          !['WAITING_FOR_PAYMENT', 'PAYMENT_RECEIVED', 'WAITING_FOR_DELIVERY'].includes(p.state)
        ) {
          store.update(id, (r) => {
            r.state = 'support_required';
            r.reason = 'cryptorefills_unknown_status';
          });
        }
      } else throw Error('Unknown Cryptorefills action');
      return store.get(id).settlement;
    } finally {
      busy.delete(id);
    }
  }
  return {
    act,
    async tick() {
      if (!adapters) return;
      for (const o of store.all()) {
        if (
          o.giftCardProvider !== 'cryptorefills' ||
          !['payment_pending', 'fulfilling'].includes(o.state)
        )
          continue;
        const action = {
          buffer_confirmed: 'prepare_topup',
          provider_order_requested: 'prepare_topup',
          topup_submitted: 'check_topup',
          provider_paid: 'check_delivery',
        }[o.settlement?.state];
        if (
          !action ||
          busy.has(o.id) ||
          (o.settlement?.lastAttemptAt && now() - o.settlement.lastAttemptAt < 10)
        )
          continue;
        try {
          await act(o.id, action);
          store.update(o.id, (r) => {
            r.settlement.retryPending = false;
          });
        } catch {
          store.update(o.id, (r) => {
            r.settlement.retryPending = true;
          });
        }
        store.update(o.id, (r) => {
          r.settlement.lastAttemptAt = now();
        });
      }
    },
  };
}
