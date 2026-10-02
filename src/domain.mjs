import { Buffer } from 'node:buffer';
import Decimal from 'decimal.js';
import { invoiceMemo, reconcileMerchantReceipts } from '@zucchinifi/dapp-sdk/merchant/server';
export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export const money = (value) => {
  try {
    const d = new Decimal(value);
    if (!d.isFinite() || d.lte(0) || d.decimalPlaces() > 2) throw 0;
    return d;
  } catch {
    throw new InputError('Enter a valid gift-card amount.');
  }
};
export function validateFace(voucher, value) {
  const d = money(value);
  if (voucher.denominationMode === 'FIXED' && !voucher.denominations.some((n) => d.eq(n)))
    throw new InputError('Choose an available amount.');
  if (
    !['FIXED', 'FLEXIBLE', 'VARIABLE', 'RANGE'].includes(voucher.denominationMode) ||
    d.lt(voucher.minAmount) ||
    d.gt(voucher.maxAmount)
  )
    throw new InputError('That amount is unavailable.');
  return d.toFixed(2);
}
export function priceOrder(quote, { rate, rateAt, now, markupBps, maxUsd }) {
  if (
    quote.currency !== 'USD' ||
    !Number.isSafeInteger(rateAt) ||
    now - rateAt > 120 ||
    rateAt > now + 30
  )
    throw new InputError('A fresh price is unavailable. Please try again.', 503);
  const cost = money(quote.payableAmount),
    r = new Decimal(rate);
  if (
    !r.isFinite() ||
    r.lte(0) ||
    !Number.isInteger(markupBps) ||
    markupBps < 0 ||
    markupBps > 10000
  )
    throw new InputError('Pricing unavailable.', 503);
  if (cost.gt(maxUsd)) throw new InputError('This gift card exceeds the current purchase limit.');
  const total = cost
    .mul(10000 + markupBps)
    .div(10000)
    .toDecimalPlaces(2, Decimal.ROUND_CEIL);
  const amount = total.div(r).mul(1e8).ceil();
  if (amount.gt('2100000000000000')) throw new InputError('Pricing unavailable.', 503);
  return {
    costUsd: cost.toFixed(2),
    totalUsd: total.toFixed(2),
    amountZatoshis: amount.toFixed(0),
    rate: r.toString(),
    rateAt,
  };
}
export function paymentUri(order) {
  const amount = new Decimal(order.amountZatoshis).div(1e8).toFixed(8);
  const memo = Buffer.from(invoiceMemo(order.id)).toString('base64url');
  return `zcash:${order.recipient}?amount=${amount}&memo=${memo}`;
}
export function reconcile(order, snapshot, now, requiredConfirmations) {
  return reconcileMerchantReceipts(
    {
      invoiceId: order.id,
      network: order.network,
      recipient: order.recipient,
      amountZatoshis: order.amountZatoshis,
      expiresAt: order.expiresAt,
    },
    snapshot,
    { now, requiredConfirmations, previouslyPaid: order.everPaid },
  );
}
