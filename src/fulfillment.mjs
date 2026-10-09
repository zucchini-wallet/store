import Decimal from 'decimal.js';
import { providerState, ProviderError } from './provider.mjs';
import { reconcile } from './domain.mjs';
export function createFulfillment({
  store,
  provider,
  config,
  now = () => Math.floor(Date.now() / 1000),
  fetcher = fetch,
}) {
  let running = false;
  async function email(order) {
    if (!order.emailOptIn || !order.email || order.emailSent || !config.resendKey) return;
    const started = order.emailStartedAt ?? now();
    if (now() - started >= 23 * 3600) {
      store.update(order.id, (o) => (o.emailNeedsReview = true));
      return;
    }
    store.update(order.id, (o) => (o.emailStartedAt = started));
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `gift-card/${order.id}`,
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [order.email],
        subject: 'Your Zucchini Store gift card is ready',
        text: `Your ${order.brand} gift card is ready.\n\n${JSON.stringify(order.card, null, 2)}\n\nKeep this email private. Your order reference: ${order.id}`,
      }),
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
    });
    if (!response.ok) throw Error('Email delivery pending');
    store.update(order.id, (o) => (o.emailSent = true));
  }
  async function process(order) {
    if (order.giftCardProvider === 'cryptorefills') return;
    if (order.state === 'delivered') {
      await email(order);
      return;
    }
    if (!['payment_pending', 'fulfilling'].includes(order.state)) return;
    const receipt = reconcile(order, order.snapshot, now(), config.confirmations);
    if (order.state === 'payment_pending' && receipt.state === 'expired') {
      store.update(order.id, (o) => (o.state = 'expired'));
      return;
    }
    if (order.state === 'payment_pending' && !receipt.canFulfill) return;
    if (!config.fulfillmentEnabled) return;
    if (order.fundingMode === 'shielded_buffer' && order.settlement?.state !== 'provider_credited')
      return;
    // Check canonical receipt freshness again before any new provider side effect.
    if (order.state === 'payment_pending') {
      const q = await provider.request(
        `/quote?voucherId=${order.voucherId}&amount=${order.faceAmount}`,
      );
      if (
        q.currency !== 'USD' ||
        Number(q.voucherId) !== order.voucherId ||
        !new Decimal(q.faceAmount).eq(order.faceAmount) ||
        new Decimal(q.payableAmount).gt(
          order.fundingMode === 'shielded_buffer' ? order.costUsd : order.totalUsd,
        )
      ) {
        store.update(order.id, (o) => {
          o.state = 'support_required';
          o.reason = 'price_changed';
        });
        return;
      }
      store.update(order.id, (o) => {
        o.state = 'fulfilling';
        o.everPaid = true;
        o.attemptedAt = now();
      });
    }
    let result;
    try {
      result = await provider.request('/clientOrderIdStatus/' + order.id);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.status !== 404) throw e;
      // Never issue a fresh provider purchase against stale or reorganized receipt evidence.
      if (!receipt.canFulfill) return;
      // Same immutable id on every retry, including recovery after a crash.
      try {
        result = await provider.request('/orders', {
          clientOrderId: order.id,
          voucherId: order.voucherId,
          amount: Number(order.faceAmount),
          email: config.fulfillmentEmail,
        });
      } catch (error) {
        if (error instanceof ProviderError && [400, 401, 403, 404].includes(error.status)) {
          store.update(order.id, (o) => {
            o.state = 'refund_review';
            o.reason = 'provider_rejected';
          });
          return;
        }
        throw error;
      }
    }
    if (result.clientOrderId !== undefined && result.clientOrderId !== order.id)
      throw Error('Provider order identity mismatch');
    if (result.currency !== undefined && result.currency !== 'USD')
      throw Error('Provider settlement currency changed');
    const state = providerState(result);
    store.update(order.id, (o) => {
      o.providerOrderId = result.orderId ?? result.id ?? o.providerOrderId;
      o.lastProviderCheck = now();
      if (state === 'succeeded') {
        if (!result.giftCardDetails) throw Error('Provider fulfillment missing card');
        o.card = result.giftCardDetails;
        o.state = 'delivered';
        o.deliveredAt = now();
      } else if (state === 'failed' || state === 'refunded') {
        o.state = 'refund_review';
        o.reason = state;
      }
    });
    const updated = store.get(order.id);
    if (updated.state === 'delivered') await email(updated);
  }
  return {
    process,
    async tick() {
      if (running) return;
      running = true;
      try {
        for (const order of store.all()) {
          if (order.lastAttemptAt && now() - order.lastAttemptAt < 10) continue;
          try {
            await process(order);
            store.update(order.id, (o) => {
              o.lastAttemptAt = now();
              o.retryPending = false;
            });
          } catch {
            store.update(order.id, (o) => {
              o.lastAttemptAt = now();
              o.retryPending = true;
            });
          }
        }
      } finally {
        running = false;
      }
    },
  };
}
