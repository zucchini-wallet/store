import { isSolanaSignature, validateSolanaTopupPlan } from './solana-settlement.mjs';
import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import { reconcile } from './domain.mjs';
import { validateShieldedAddress } from './payment-memo.mjs';
const externalHash = (value, network) =>
  network === 'sol'
    ? isSolanaSignature(value)
    : typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value);
const hash = (value) => typeof value === 'string' && /^(?:0x)?[a-f0-9]{64}$/i.test(value);
const requireValue = (ok, message) => {
  if (!ok) throw Error(message);
};
// Adapter methods MUST verify source evidence (chain RPC/provider ledger), never browser claims.
export function createSettlement({
  store,
  config,
  adapters,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const busy = new Set();
  const update = (id, fn) => store.update(id, fn);
  async function act(id, action, input = {}) {
    requireValue(!busy.has(id), 'Settlement action already running');
    busy.add(id);
    try {
      const o = store.get(id);
      requireValue(o?.fundingMode === 'shielded_buffer', 'Not a buffered order');
      requireValue(
        o.giftCardProvider !== 'cryptorefills' ||
          !['prepare_topup', 'begin_topup', 'submit_topup', 'check_topup'].includes(action),
        'Use the Cryptorefills settlement coordinator',
      );
      if (
        ['prepare_conversion', 'begin_conversion', 'prepare_topup', 'begin_topup'].includes(action)
      )
        requireValue(o.state === 'payment_pending', 'Order is paused or no longer payable');
      const minimumSettlement = new Decimal(o.costUsd)
        .plus(config.minimumRetainedMarginUsd ?? '0')
        .mul(1e6);
      requireValue(
        minimumSettlement.isFinite() && minimumSettlement.gte(new Decimal(o.costUsd).mul(1e6)),
        'Invalid margin policy',
      );
      const s = o.settlement ?? { state: 'awaiting_receipt' };
      const fresh = () =>
        reconcile(store.get(id), store.get(id).snapshot, now(), config.confirmations).canFulfill;
      if (action === 'prepare_conversion') {
        requireValue(adapters?.quote, 'Conversion adapter not configured');
        requireValue(
          s.state === 'awaiting_receipt' && fresh(),
          'Confirmed canonical receipt required',
        );
        // Persist before external quote creation. An ambiguous response requires explicit recovery.
        update(id, (r) => {
          r.settlement = { ...s, state: 'quote_requested', attemptId: randomUUID() };
          r.everPaid = true;
        });
        const q = await adapters.quote(o);
        if (typeof q?.orderId === 'string' && q.orderId.length <= 128)
          update(id, (r) => {
            r.settlement.providerOrderReference = q.orderId;
          });
        requireValue(
          q.orderId &&
            q.originAsset === 'nep141:zec.omft.near' &&
            q.destinationAsset === config.settlementAsset &&
            q.recipientAddress === config.bufferAddress &&
            q.refundAddress === config.conversionRefundAddress,
          'Conversion binding mismatch',
        );
        requireValue(
          q.amountInAtomic === o.amountZatoshis &&
            Number.isSafeInteger(q.deadline) &&
            q.deadline > now(),
          'Expired or changed conversion quote',
        );
        requireValue(
          /^[1-9][0-9]{0,30}$/.test(q.minimumOutputAtomic) &&
            new Decimal(q.minimumOutputAtomic).gte(minimumSettlement),
          'Minimum output does not cover provider cost and required retained margin',
        );
        requireValue(
          q.signatureVerified === true &&
            typeof q.depositAddress === 'string' &&
            /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(q.depositAddress) &&
            !q.memo,
          'Invalid Zcash conversion deposit',
        );
        requireValue(
          !store
            .all()
            .some(
              (r) =>
                r.id !== id &&
                (r.settlement?.quote?.orderId === q.orderId ||
                  r.settlement?.quote?.depositAddress === q.depositAddress),
            ),
          'Conversion already assigned',
        );
        update(
          id,
          (r) => (r.settlement = { ...r.settlement, state: 'conversion_ready', quote: q }),
        );
      } else if (action === 'recover_quote') {
        requireValue(
          s.state === 'quote_requested' && adapters?.recoverQuote,
          'Quote recovery unavailable',
        );
        // No automatic fresh quote: recover the original durable gateway record.
        const q = await adapters.recoverQuote(o, s.attemptId, input.orderId);
        requireValue(q === null, 'Recover original quote through adapter before continuing');
        update(id, (r) => (r.settlement = { state: 'awaiting_receipt' }));
      } else if (action === 'begin_conversion') {
        requireValue(
          s.state === 'conversion_ready' && s.quote.deadline > now() && fresh(),
          'Conversion no longer payable',
        );
        update(id, (r) => (r.settlement = { ...s, state: 'conversion_signing' }));
      } else if (action === 'submit_conversion') {
        requireValue(
          ['conversion_signing', 'conversion_submitted'].includes(s.state) &&
            /^[a-f0-9]{64}$/i.test(input.txid ?? ''),
          'Invalid conversion submission',
        );
        requireValue(
          !s.conversionTxid || s.conversionTxid === input.txid,
          'Conversion transaction changed',
        );
        update(
          id,
          (r) =>
            (r.settlement = { ...s, state: 'conversion_submitted', conversionTxid: input.txid }),
        );
        await adapters?.notifyDeposit?.(o, s.quote, input.txid);
      } else if (action === 'check_conversion') {
        requireValue(
          ['conversion_submitted', 'conversion_signing'].includes(s.state) &&
            adapters?.conversionStatus,
          'Conversion status unavailable',
        );
        const result = await adapters.conversionStatus(o, s);
        requireValue(result.orderId === s.quote.orderId, 'Wrong conversion status');
        if (['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(result.status))
          update(id, (r) => {
            r.state = 'refund_review';
            r.reason = 'conversion_' + result.status.toLowerCase();
            r.settlement = { ...s, state: 'conversion_review', result };
          });
        else if (result.status === 'SUCCESS') {
          const evidence = await adapters.verifyBufferReceipt(o, s, result);
          requireValue(
            result.destinationTransactions?.some((t) =>
              config.settlementNetwork === 'sol'
                ? t.hash === evidence.txid
                : t.hash.toLowerCase() === evidence.txid?.toLowerCase(),
            ) &&
              result.originTransactions?.some(
                (t) => t.hash.toLowerCase() === s.conversionTxid?.toLowerCase(),
              ) &&
              /^[1-9][0-9]{0,30}$/.test(evidence.amountAtomic) &&
              evidence.canonical === true &&
              evidence.confirmed === true &&
              evidence.token === config.settlementAsset &&
              evidence.network === config.settlementNetwork &&
              evidence.recipient === config.bufferAddress &&
              new Decimal(evidence.amountAtomic).gte(minimumSettlement) &&
              externalHash(evidence.txid, config.settlementNetwork),
            'Unverified stablecoin output',
          );
          requireValue(
            !store
              .all()
              .some(
                (r) =>
                  r.id !== id &&
                  r.settlement?.bufferReceipt?.txid === evidence.txid &&
                  r.settlement?.bufferReceipt?.logIndex === evidence.logIndex,
              ),
            'Buffer receipt already assigned',
          );
          update(
            id,
            (r) =>
              (r.settlement = {
                ...s,
                state: 'buffer_confirmed',
                bufferReceipt: evidence,
                retainedMarginAtomic: new Decimal(evidence.amountAtomic)
                  .minus(new Decimal(o.costUsd).mul(1e6))
                  .toFixed(0),
              }),
          );
        }
      } else if (action === 'prepare_topup') {
        requireValue(
          s.state === 'buffer_confirmed' && adapters?.prepareTopup,
          'Top-up adapter unavailable',
        );
        const plan = await adapters.prepareTopup(o, s);
        const amount = new Decimal(o.costUsd).mul(1e6).ceil().toFixed(0);
        requireValue(new Decimal(o.costUsd).gte(10), 'Provider minimum top-up is $10');
        requireValue(
          plan.token === config.settlementAsset &&
            plan.network === config.settlementNetwork &&
            plan.from === config.bufferAddress &&
            plan.to === config.providerDepositAddress &&
            plan.amountAtomic === amount,
          'Top-up plan mismatch',
        );
        if (config.settlementNetwork === 'sol') {
          requireValue(
            plan.maxFeeLamports === config.solanaMaxFeeLamports &&
              plan.maxRentLamports === config.solanaMaxRentLamports,
            'Configured Solana fee/rent policy required',
          );
          await validateSolanaTopupPlan(plan, {
            from: config.bufferAddress,
            to: config.providerDepositAddress,
            amountAtomic: amount,
          });
        }
        update(id, (r) => (r.settlement = { ...s, state: 'topup_ready', topupPlan: plan }));
      } else if (action === 'begin_topup') {
        requireValue(s.state === 'topup_ready', 'Top-up is not ready');
        update(id, (r) => (r.settlement = { ...s, state: 'topup_signing' }));
      } else if (action === 'submit_topup') {
        requireValue(
          ['topup_signing', 'topup_submitted'].includes(s.state) &&
            externalHash(input.txid, config.settlementNetwork),
          'Invalid top-up submission',
        );
        requireValue(!s.topupTxid || s.topupTxid === input.txid, 'Top-up transaction changed');
        update(
          id,
          (r) => (r.settlement = { ...s, state: 'topup_submitted', topupTxid: input.txid }),
        );
      } else if (action === 'check_topup') {
        requireValue(
          ['topup_signing', 'topup_submitted'].includes(s.state) && adapters?.verifyTopup,
          'Top-up verification unavailable',
        );
        const e = await adapters.verifyTopup(o, s);
        requireValue(
          e.canonical &&
            e.confirmed &&
            e.token === s.topupPlan.token &&
            e.network === s.topupPlan.network &&
            e.from === s.topupPlan.from &&
            e.to === s.topupPlan.to &&
            e.amountAtomic === s.topupPlan.amountAtomic &&
            e.txid === s.topupTxid,
          'Unverified top-up',
        );
        const credit = await adapters.verifyProviderCredit(o, s, e);
        requireValue(
          credit.type === 'TOPUP' &&
            credit.currency === 'USD' &&
            credit.txid === s.topupTxid &&
            credit.id &&
            new Decimal(credit.amountUsd).gte(o.costUsd),
          'Provider credit not matched',
        );
        requireValue(
          !store.all().some((r) => r.id !== id && r.settlement?.credit?.id === credit.id),
          'Provider credit already assigned',
        );
        update(id, (r) => {
          r.settlement = { ...s, state: 'provider_credited', credit, topupReceipt: e };
        });
      } else if (action === 'prepare_reply') {
        requireValue(
          o.state === 'delivered' &&
            ['provider_credited', 'provider_paid', 'reply_ready'].includes(s.state),
          'Card not delivered',
        );
        if (s.state === 'reply_ready') return s;
        validateShieldedAddress(o.replyAddress, o.network);
        requireValue(
          /^[1-9][0-9]*$/.test(config.replyAmountZatoshis ?? ''),
          'Reply amount not configured',
        );
        requireValue(
          /^[A-Za-z0-9_-]{43}$/.test(o.recoveryToken ?? ''),
          'Recovery token unavailable',
        );
        const memo = JSON.stringify({
          v: 1,
          order: id,
          url: config.origin + '/#order=' + id + '&key=' + o.recoveryToken,
        });
        requireValue(new TextEncoder().encode(memo).length <= 512, 'Reply memo too long');
        update(
          id,
          (r) =>
            (r.settlement = {
              ...s,
              state: 'reply_ready',
              replyPlan: {
                recipient: o.replyAddress,
                amountZatoshis: config.replyAmountZatoshis,
                memo,
              },
            }),
        );
      } else if (action === 'begin_reply') {
        requireValue(s.state === 'reply_ready', 'Reply not ready');
        update(id, (r) => (r.settlement = { ...s, state: 'reply_signing' }));
      } else if (action === 'submit_reply') {
        requireValue(
          ['reply_signing', 'reply_submitted'].includes(s.state) &&
            /^[a-f0-9]{64}$/i.test(input.txid ?? ''),
          'Invalid reply submission',
        );
        requireValue(!s.replyTxid || s.replyTxid === input.txid, 'Reply transaction changed');
        update(
          id,
          (r) => (r.settlement = { ...s, state: 'reply_submitted', replyTxid: input.txid }),
        );
      } else if (action === 'check_reply') {
        requireValue(
          s.state === 'reply_submitted' && adapters?.verifyReply,
          'Reply verification unavailable',
        );
        const e = await adapters.verifyReply(o, s);
        requireValue(
          e.confirmed &&
            e.canonical &&
            e.txid === s.replyTxid &&
            e.recipient === o.replyAddress &&
            e.amountZatoshis === s.replyPlan.amountZatoshis &&
            e.memo === s.replyPlan.memo,
          'Unverified reply transfer',
        );
        update(id, (r) => (r.settlement = { ...s, state: 'reply_confirmed', replyReceipt: e }));
      } else throw Error('Unknown settlement action');
      return store.get(id).settlement;
    } catch (error) {
      const latest = store.get(id);
      if (action === 'prepare_conversion' && latest?.settlement?.state === 'quote_requested') {
        update(id, (r) => {
          r.state = 'support_required';
          r.reason = 'conversion_quote_review';
        });
      }
      throw error;
    } finally {
      busy.delete(id);
    }
  }
  return {
    act,
    async tick() {
      if (!adapters) return;
      for (const order of store.all()) {
        if (
          (order.giftCardProvider === 'cryptorefills' &&
            [
              'buffer_confirmed',
              'provider_order_requested',
              'topup_ready',
              'topup_signing',
              'topup_submitted',
              'provider_paid',
            ].includes(order.settlement?.state) &&
            order.state !== 'delivered') ||
          order.fundingMode !== 'shielded_buffer' ||
          ['refund_review', 'support_required', 'refund_submitted'].includes(order.state)
        )
          continue;
        const state = order.settlement?.state;
        const action =
          state === 'awaiting_receipt' &&
          reconcile(order, order.snapshot, now(), config.confirmations).canFulfill
            ? 'prepare_conversion'
            : state === 'conversion_submitted'
              ? 'check_conversion'
              : state === 'buffer_confirmed'
                ? 'prepare_topup'
                : state === 'topup_submitted'
                  ? 'check_topup'
                  : ['provider_credited', 'provider_paid'].includes(state) &&
                      order.state === 'delivered'
                    ? 'prepare_reply'
                    : state === 'reply_submitted'
                      ? 'check_reply'
                      : undefined;
        if (!action || busy.has(order.id)) continue;
        try {
          await act(order.id, action);
          update(order.id, (r) => {
            r.settlement.retryPending = false;
          });
        } catch {
          update(order.id, (r) => {
            r.settlement.retryPending = true;
          });
        }
      }
    },
  };
}
