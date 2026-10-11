import {
  validateDirectInvoice,
  resolveDirectInvoiceDestination,
  bindDirectSwapQuote,
  directPaymentUri,
  validateTransparentRefundAddress,
} from './direct-payment.mjs';
import { SOLANA_USDC, isSolanaSignature } from './solana-settlement.mjs';

const demand = (ok, message) => {
  if (!ok) throw Error(message);
};
const atomic = (value, maximum) =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= BigInt(maximum);
const terminal = new Set(['delivered', 'cancelled', 'refund_review', 'support_required']);

// All adapters are server-owned reviewed mappings/transports. No browser evidence,
// signer, merchant balance, outgoing Zcash adapter, or automatic order POST retries.
export function createDirectSettlement({
  store,
  config,
  adapters,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const busy = new Set();
  const policy = {
    requiredRemainingSeconds: config.directApprovalSeconds ?? 120,
    settlementMarginSeconds: config.directSettlementMarginSeconds ?? 600,
  };
  function checkOrder(o) {
    demand(
      o?.fundingMode === 'direct_swap' && o.giftCardProvider === 'cryptorefills',
      'Not a direct Cryptorefills order',
    );
    demand(adapters, 'Direct payment adapters unavailable');
    demand(
      atomic(o.maxInputZatoshis, '2100000000000000') &&
        atomic(o.expectedUsdcAtomic, String(BigInt(config.maxUsd ?? 200) * 1000000n)),
      'Customer payment caps unavailable',
    );
    validateTransparentRefundAddress(o.refundAddress);
  }
  function unique(o, field, value) {
    demand(
      !store
        .all()
        .some(
          (r) => r.id !== o.id && r.fundingMode === 'direct_swap' && r.direct?.[field] === value,
        ),
      'Payment evidence already assigned',
    );
  }
  async function act(id, action, input = {}) {
    demand(!busy.has(id), 'Direct payment action already running');
    busy.add(id);
    let o;
    try {
      o = store.get(id);
      checkOrder(o);
      const mutate = (fn) => {
        const revision = o.direct?.revision ?? 0;
        store.update(id, (r) => {
          demand(
            (r.direct?.revision ?? 0) === revision && r.state === o.state,
            'Order changed during verification',
          );
          fn(r);
          r.direct = { ...r.direct, revision: revision + 1 };
        });
        o = store.get(id);
      };
      const persistInvoice = async (p) => {
        const invoice = validateDirectInvoice(p, {
          externalOrderId: id,
          previousInvoice: o.direct?.invoice,
          now: now(),
          requiredRemainingSeconds:
            policy.requiredRemainingSeconds + policy.settlementMarginSeconds,
          maxAmountAtomic: o.expectedUsdcAtomic,
        });
        demand(invoice.amountAtomic === o.expectedUsdcAtomic, 'Provider price changed');
        unique(o, 'providerOrderId', invoice.orderId);
        mutate((r) => {
          r.direct = {
            ...r.direct,
            state: 'invoice_ready',
            providerOrderId: invoice.orderId,
            invoice,
          };
          r.state = 'preparing';
        });
      };
      if (action === 'prepare' || action === 'recover_invoice') {
        demand(config.checkoutEnabled && config.fulfillmentEnabled, 'Direct checkout is disabled');
        if (action === 'prepare') {
          demand(o.state === 'quoted' && now() < o.quoteExpiresAt, 'Quote expired');
          mutate((r) => {
            r.state = 'preparing';
            r.direct = { ...r.direct, state: 'invoice_requesting', requestedAt: now() };
          });
        } else {
          demand(
            ['invoice_requesting', 'invoice_unknown'].includes(o.direct?.state),
            'Invoice recovery is unavailable',
          );
          // Explicit recovery reuses the same provider external_order_id. Tick never POSTs.
          mutate((r) => {
            r.state = 'preparing';
            r.direct.state = 'invoice_requesting';
          });
        }
        try {
          await persistInvoice(await adapters.createInvoice(o));
        } catch (e) {
          mutate((r) => {
            r.state = 'support_required';
            r.direct.state = 'invoice_unknown';
          });
          throw e;
        }
      } else if (action === 'prepare_swap' || action === 'recover_swap') {
        demand(config.checkoutEnabled && config.fulfillmentEnabled, 'Direct checkout is disabled');
        demand(
          ['invoice_ready', 'swap_requesting', 'swap_unknown'].includes(o.direct?.state),
          'Provider invoice required',
        );
        const invoice = validateDirectInvoice(o.direct.invoice, {
          externalOrderId: id,
          now: now(),
          maxAmountAtomic: o.expectedUsdcAtomic,
          requiredRemainingSeconds:
            policy.requiredRemainingSeconds + policy.settlementMarginSeconds,
        });
        const destinationEvidence = await adapters.readInvoiceAccount(invoice);
        const destination = await resolveDirectInvoiceDestination(invoice, destinationEvidence);
        if (action === 'prepare_swap') {
          demand(o.direct.state === 'invoice_ready', 'Recover the original swap before retrying');
          mutate((r) => {
            r.direct.state = 'swap_requesting';
            r.state = 'preparing';
          });
        }
        try {
          const args = {
            clientRequestId: id,
            amountAtomic: invoice.amountAtomic,
            recipientAddress: destination.owner,
            refundAddress: o.refundAddress,
            deadlineEpochSeconds: invoice.expiresAt - policy.settlementMarginSeconds,
          };
          const quote =
            action === 'recover_swap'
              ? await adapters.recoverSwap(o, args)
              : await adapters.quoteSwap(o, args);
          const binding = await bindDirectSwapQuote({
            externalOrderId: id,
            invoice,
            destinationEvidence,
            quote,
            refundAddress: o.refundAddress,
            maxInputZatoshis: o.maxInputZatoshis,
            maxAmountAtomic: o.expectedUsdcAtomic,
            now: now(),
            ...policy,
            previousBinding: o.direct.binding,
          });
          unique(o, 'gatewayOrderId', binding.gatewayOrderId);
          mutate((r) => {
            r.state = 'quoted';
            r.amountZatoshis = binding.amountInAtomic;
            r.recipient = binding.depositAddress;
            r.expiresAt = binding.depositDeadline;
            r.quoteExpiresAt = binding.latestApprovalAt;
            r.direct = {
              ...r.direct,
              state: 'quote_ready',
              binding,
              gatewayOrderId: binding.gatewayOrderId,
            };
          });
        } catch (e) {
          mutate((r) => {
            r.state = 'support_required';
            r.direct.state = 'swap_unknown';
          });
          throw e;
        }
      } else if (action === 'begin_payment') {
        demand(config.checkoutEnabled && config.fulfillmentEnabled, 'Direct checkout is disabled');
        demand(
          o.state === 'quoted' && o.direct?.state === 'quote_ready',
          'Bound payment quote required',
        );
        directPaymentUri(o.direct.binding, { now: now() });
        mutate((r) => {
          r.state = 'payment_pending';
          r.paymentStartedAt = now();
          r.direct.state = 'payment_requested';
          r.direct.nextPollAt = now();
        });
      } else if (action === 'submitted') {
        demand(
          [
            'payment_pending',
            'fulfilling',
            'support_required',
            'delivered',
            'refund_review',
          ].includes(o.state) &&
            o.paymentStartedAt &&
            /^[a-f0-9]{64}$/i.test(input.txid ?? ''),
          'Invalid payment submission',
        );
        const txid = input.txid.toLowerCase();
        demand(!o.txid || o.txid === txid, 'Payment transaction changed');
        // The wallet txid is a hint. A lost notification is safe to repeat; never pay again.
        mutate((r) => {
          r.txid = txid;
        });
        try {
          await adapters.notifyDeposit(o, o.direct.binding, txid);
        } catch {
          mutate((r) => {
            r.direct.notificationPending = true;
          });
        }
      } else if (action === 'cancel') {
        demand(
          !o.paymentStartedAt &&
            ['quoted', 'preparing'].includes(o.state) &&
            [undefined, 'draft', 'invoice_ready', 'quote_ready'].includes(o.direct?.state),
          'Payment may be underway; cancellation requires review',
        );
        if (o.direct?.invoice) {
          mutate((r) => {
            r.state = 'preparing';
            r.direct.state = 'cancel_requesting';
          });
          try {
            const p = await adapters.cancelInvoice(o);
            demand(
              p.orderId === o.direct.invoice.orderId &&
                p.externalOrderId === id &&
                ['CANCELED', 'CANCELLED', 'EXPIRED'].includes(p.state),
              'Cancellation not confirmed',
            );
          } catch (e) {
            mutate((r) => {
              r.state = 'support_required';
              r.direct.state = 'cancel_unknown';
            });
            throw e;
          }
        }
        mutate((r) => {
          r.state = 'cancelled';
          r.direct.state = 'cancelled';
        });
      } else if (action === 'recover_cancel') {
        demand(
          !o.paymentStartedAt && ['cancel_requesting', 'cancel_unknown'].includes(o.direct?.state),
          'Cancellation recovery is unavailable',
        );
        // Read the original provider order. Never repeat DELETE or restore payment.
        const p = await adapters.getInvoice(o);
        demand(
          p.orderId === o.direct.invoice.orderId &&
            p.externalOrderId === id &&
            ['CANCELED', 'CANCELLED', 'EXPIRED'].includes(p.state),
          'Cancellation not confirmed',
        );
        mutate((r) => {
          r.state = 'cancelled';
          r.direct.state = 'cancelled';
        });
      } else if (action === 'poll') {
        demand(
          o.paymentStartedAt &&
            o.direct?.binding &&
            (!terminal.has(o.state) ||
              (o.state === 'support_required' && o.direct.state === 'verification_review')),
          'Payment status is unavailable',
        );
        demand(now() >= (o.direct.nextPollAt ?? 0), 'Status refresh is cooling down');
        // Persist throttle before transport, so a restart cannot cause a retry loop.
        mutate((r) => {
          r.direct.nextPollAt = now() + 15;
        });
        const result = await adapters.swapStatus(o, o.direct.binding);
        demand(
          result.orderId === o.direct.binding.gatewayOrderId &&
            result.providerQuoteId === o.direct.binding.providerQuoteId,
          'Swap status identity mismatch',
        );
        demand(result.trackingSource === 'one_click_status', 'Authoritative swap status required');
        if (result.status === 'SUCCESS') {
          demand(
            result.amounts?.amountOutAtomic === o.direct.invoice.amountAtomic,
            'Swap output differs from invoice',
          );
          const refs = [...new Set((result.destinationTransactions ?? []).map((t) => t.hash))];
          demand(
            refs.length > 0 && refs.length <= 10 && refs.every(isSolanaSignature),
            'Swap payment references unavailable',
          );
          const matches = [];
          for (const txid of refs) {
            try {
              matches.push(await adapters.verifyPayout(o.direct.binding, txid));
            } catch {
              /* An unrelated or unfinalized reference cannot establish payment. */
            }
          }
          demand(matches.length === 1, 'Finalized invoice payment is missing or ambiguous');
          const e = matches[0],
            b = o.direct.binding;
          demand(
            e.canonical === true &&
              e.confirmed === true &&
              refs.includes(e.txid) &&
              e.network === 'sol' &&
              e.token === SOLANA_USDC.asset &&
              e.to === b.recipientAddress &&
              e.destinationAccount === b.destinationAccount &&
              e.amountAtomic === b.amountOutAtomic &&
              typeof e.logIndex === 'string',
            'Finalized payment does not match bound invoice',
          );
          store.claimEvidence(id, `solana/${e.txid}/${e.logIndex}/${e.destinationAccount}`);
          mutate((r) => {
            r.state = 'fulfilling';
            r.direct.state = 'provider_payment_confirmed';
            r.direct.payout = e;
          });
        } else if (['REFUNDED', 'FAILED'].includes(result.status)) {
          mutate((r) => {
            r.state = 'refund_review';
            r.direct.state = 'swap_refund_review';
            r.reason = 'Check swap refund status and your transparent Zcash refund address.';
          });
          return o.direct;
        } else {
          demand(
            ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'INCOMPLETE_DEPOSIT'].includes(
              result.status,
            ),
            'Unknown swap status requires review',
          );
          mutate((r) => {
            r.direct.swapStatus = result.status;
          });
        }
        const p = await adapters.getInvoice(o),
          invoice = o.direct.invoice;
        demand(
          p.orderId === invoice.orderId && p.externalOrderId === id,
          'Provider status identity mismatch',
        );
        if (p.state === 'COMPLETED') {
          demand(
            o.direct.payout &&
              p.payment?.accepted === true &&
              p.payment.amountAtomic === invoice.amountAtomic &&
              p.payment.coin === 'USDC' &&
              p.payment.network === 'Solana' &&
              p.payment.recipient === invoice.recipient &&
              p.delivery?.beneficiary === o.email &&
              p.delivery.brand === o.brand &&
              p.delivery.country === o.country &&
              p.delivery.faceAmount === o.faceAmount &&
              p.delivery.providerProductId === o.providerProductId &&
              p.delivery.card &&
              typeof p.delivery.card === 'object' &&
              !Array.isArray(p.delivery.card) &&
              Object.keys(p.delivery.card).length > 0,
            'Provider payment acceptance and matching delivery required',
          );
          mutate((r) => {
            r.state = 'delivered';
            r.deliveredAt = now();
            r.card = p.delivery.card;
            r.direct.state = 'delivered';
            r.direct.failures = 0;
          });
        } else if (
          ['EXPIRED', 'CANCELED', 'CANCELLED', 'REFUNDED', 'PAYMENT_FAILED'].includes(p.state)
        ) {
          mutate((r) => {
            r.state = 'refund_review';
            r.direct.state = 'provider_refund_review';
            r.reason = 'Check Cryptorefills email for payment review and any eligible USDC refund.';
          });
        } else {
          demand(
            ['WAITING_FOR_PAYMENT', 'PAYMENT_RECEIVED', 'WAITING_FOR_DELIVERY'].includes(p.state),
            'Unknown provider status requires review',
          );
          mutate((r) => {
            r.direct.failures = 0;
          });
        }
      } else throw Error('Unknown direct payment action');
      return o.direct;
    } catch (e) {
      const error = e instanceof Error ? e : Error('Direct action unavailable');
      error.directRevision = o?.direct?.revision;
      throw error;
    } finally {
      busy.delete(id);
    }
  }
  return {
    act,
    async tick() {
      if (!adapters || !config.fulfillmentEnabled) return;
      for (const o of store.all()) {
        if (
          o.fundingMode !== 'direct_swap' ||
          !o.paymentStartedAt ||
          terminal.has(o.state) ||
          busy.has(o.id) ||
          now() < (o.direct?.nextPollAt ?? 0)
        )
          continue;
        try {
          await act(o.id, 'poll');
        } catch (e) {
          store.update(o.id, (r) => {
            if (terminal.has(r.state) || r.direct?.revision !== e.directRevision) return;
            const failures = Math.min((r.direct?.failures ?? 0) + 1, 8);
            const retry = Math.max(15 * 2 ** failures, e.retryAfterSeconds ?? 0);
            r.direct = {
              ...r.direct,
              failures,
              revision: (r.direct?.revision ?? 0) + 1,
              nextPollAt: now() + Math.min(retry, 30 * 86400),
            };
            // Keep polling transport/finality delays; never retry order/quote creation.
            if (failures >= 8) {
              r.state = 'support_required';
              r.direct.state = 'verification_review';
            }
          });
        }
      }
    },
  };
}
