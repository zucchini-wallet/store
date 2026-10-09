import {
  createPaymentMemo,
  matchesPaymentMemo,
  paymentMemo,
  validateShieldedAddress,
} from './payment-memo.mjs';
import { createCryptorefillsSettlement } from './cryptorefills-settlement.mjs';
import { createSettlement } from './settlement.mjs';
import { Buffer } from 'node:buffer';
import { catalogPage } from './catalog.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { secureEqual } from './config.mjs';
import { validateFace, priceOrder, paymentUri, reconcile, InputError } from './domain.mjs';
import Decimal from 'decimal.js';
export function createApp({
  config,
  store,
  provider,
  catalog,
  clock = () => Math.floor(Date.now() / 1000),
  priceFetcher = fetch,
  settlementAdapters,
  cryptorefillsAdapters,
  runtimeReadiness,
  getSolanaBlockHeight,
}) {
  const settlement = createSettlement({ store, config, adapters: settlementAdapters, now: clock });
  const cryptorefills = createCryptorefillsSettlement({
    store,
    config,
    adapters: cryptorefillsAdapters,
    now: clock,
  });
  const buckets = new Map();
  let priceCache, balanceCache;
  const now = clock;
  function limited(key, max = 30) {
    const t = now();
    let b = buckets.get(key);
    if (!b || t - b.start >= 60) b = { start: t, n: 0 };
    if (++b.n > max) throw new InputError('Please wait a moment and try again.', 429);
    buckets.set(key, b);
    if (buckets.size > 10000) for (const [k, v] of buckets) if (t - v.start > 60) buckets.delete(k);
  }
  async function body(req) {
    let bytes = 0,
      parts = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 256000) throw new InputError('Request too large.', 413);
      parts.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString());
    } catch {
      throw new InputError('Invalid request.');
    }
  }
  async function rate() {
    if (priceCache && now() - priceCache.last_updated_at < 90) return priceCache;
    const r = await priceFetcher(
      'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd&include_last_updated_at=true',
      { signal: AbortSignal.timeout(10000), redirect: 'manual' },
    );
    if (!r.ok) throw new InputError('A fresh Zcash price is unavailable.', 503);
    priceCache = (await r.json()).zcash;
    return priceCache;
  }
  async function balance() {
    if (balanceCache && now() - balanceCache.at < 30) return balanceCache.amount;
    const b = await provider.request('/balance');
    if (b.currency !== 'USD') throw new InputError('Store funding is unavailable.', 503);
    balanceCache = { at: now(), amount: new Decimal(b.balance) };
    return balanceCache.amount;
  }
  let scannerHeartbeat = 0;
  const liveReady = () =>
    Boolean(
      config.checkoutEnabled &&
        provider &&
        catalog.fetchedAt &&
        (config.giftCardProvider !== 'cryptorefills' ||
          (catalog.provider === 'cryptorefills' &&
            config.fundingMode === 'shielded_buffer' &&
            cryptorefillsAdapters &&
            provider.quoteProduct)) &&
        Date.now() - Date.parse(catalog.fetchedAt) < 48 * 3600000 &&
        now() - scannerHeartbeat <= 90,
    );
  const catalogPreview = () =>
    config.giftCardProvider === 'cryptorefills' &&
    catalog.provider !== 'cryptorefills' &&
    !config.checkoutEnabled;
  function publicOrder(o) {
    const receipt =
      o.state === 'quoted' ? undefined : reconcile(o, o.snapshot, now(), config.confirmations);
    return {
      id: o.id,
      brand: o.brand,
      name: o.name,
      iconUrl: o.iconUrl,
      country: o.country,
      faceAmount: o.faceAmount,
      currency: o.currency,
      totalUsd: o.totalUsd,
      amountZatoshis: o.amountZatoshis,
      network: o.network,
      recipient: o.recipient,
      expiresAt: o.expiresAt,
      quoteExpiresAt: o.quoteExpiresAt,
      state: o.state,
      receipt,
      refundTxid: o.refundTxid,
      emailOptIn: o.emailOptIn,
      emailSent: Boolean(o.emailSent),
      refundRequested: Boolean(o.refundRequested),
      settlementState: o.settlement?.state,
      replyTxid: o.settlement?.replyTxid,
      ...(o.state === 'payment_pending' ? { paymentUri: paymentUri(o) } : {}),
      ...(o.state === 'delivered' ? { card: o.card } : {}),
      supportEmail: config.supportEmail,
    };
  }
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://0fiat.com https://cdn.cryptorefills.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      const u = new URL(req.url, config.origin),
        ip = req.socket.remoteAddress;
      const admin =
        req.headers.authorization?.startsWith('Bearer ') &&
        config.adminToken.length >= 32 &&
        secureEqual(req.headers.authorization.slice(7), config.adminToken);
      if (u.pathname.startsWith('/internal/')) {
        if (!admin) throw new InputError('Unauthorized', 401);
        if (req.method === 'GET' && u.pathname === '/internal/health') {
          let funds, providerStatus, providerDiagnostic;
          try {
            funds =
              config.giftCardProvider !== 'cryptorefills' && provider
                ? await provider.request('/balance')
                : undefined;
            providerStatus =
              config.giftCardProvider === 'cryptorefills' ? undefined : provider ? 200 : undefined;
          } catch (e) {
            providerStatus = e.status ?? e.name;
            providerDiagnostic = provider?.describeError?.(e);
          }
          return json(200, {
            providerStatus,
            providerDiagnostic,
            network: config.network,
            checkoutEnabled: config.checkoutEnabled,
            scannerFresh: now() - scannerHeartbeat <= 90,
            providerConfigured: Boolean(provider),
            giftCardProvider: config.giftCardProvider ?? '0fiat',
            runtimeReadiness,
            providerConnectivityVerified:
              config.giftCardProvider !== 'cryptorefills' && providerStatus === 200,
            providerBalance: funds?.balance,
            providerCurrency: funds?.currency,
            catalogCount: catalog.vouchers.length,
            catalogUpdatedAt: catalog.fetchedAt,
          });
        }
        if (req.method === 'GET' && u.pathname === '/internal/solana-height') {
          if (!getSolanaBlockHeight) throw new InputError('Solana RPC is not configured.', 503);
          return json(200, { blockHeight: await getSolanaBlockHeight() });
        }
        if (req.method === 'GET' && u.pathname === '/internal/settlements')
          return json(200, {
            orders: store
              .all()
              .filter((o) => o.fundingMode === 'shielded_buffer')
              .map((o) => ({
                id: o.id,
                state: o.state,
                network: o.network,
                settlement: o.settlement,
                amountZatoshis: o.amountZatoshis,
              })),
          });
        if (req.method === 'POST' && u.pathname === '/internal/settlement') {
          const b = await body(req);
          if (
            !config.fulfillmentEnabled &&
            [
              'prepare_conversion',
              'recover_quote',
              'begin_conversion',
              'prepare_topup',
              'begin_topup',
              'prepare_reply',
              'begin_reply',
            ].includes(b.action)
          )
            throw new InputError('Settlement approvals are disabled.', 503);
          try {
            return json(200, {
              settlement: await (
                store.get(b.orderId)?.giftCardProvider === 'cryptorefills' &&
                [
                  'prepare_topup',
                  'begin_topup',
                  'submit_topup',
                  'check_topup',
                  'check_delivery',
                ].includes(b.action)
                  ? cryptorefills
                  : settlement
              ).act(b.orderId, b.action, b.input),
            });
          } catch (e) {
            throw new InputError(e.message, 409);
          }
        }
        if (req.method === 'GET' && u.pathname === '/internal/orders')
          return json(200, {
            orders: store
              .all()
              .filter((o) => o.state !== 'quoted' && o.state !== 'cancelled')
              .map((o) => ({
                id: o.id,
                network: o.network,
                recipient: o.recipient,
                expiresAt: o.expiresAt,
                paymentMemo: paymentMemo(o),
                replyAddress: o.replyAddress,
              })),
            network: config.network,
            recipient: config.recipient,
          });
        if (req.method === 'POST' && u.pathname === '/internal/heartbeat') {
          const b = await body(req);
          if (
            b.network !== config.network ||
            b.recipient !== config.recipient ||
            b.caughtUp !== true
          )
            throw new InputError('Scanner not caught up');
          scannerHeartbeat = now();
          return json(200, { ok: true });
        }
        if (req.method === 'POST' && u.pathname === '/internal/receipt') {
          const { orderId, snapshot } = await body(req);
          const o = store.get(orderId);
          if (!o || o.state === 'quoted') throw new InputError('Unknown payment');
          if (o.snapshot && snapshot.sequence <= o.snapshot.sequence)
            throw new InputError('Stale scanner sequence');
          const receipt = reconcile(o, snapshot, now(), config.confirmations);
          store.claimReceipts(
            o.id,
            snapshot.receipts.filter(
              (r) => r.recipient === o.recipient && matchesPaymentMemo(r, o),
            ),
          );
          store.update(o.id, (r) => {
            r.snapshot = snapshot;
            if (r.everPaid && !receipt.canFulfill && r.state === 'delivered') {
              r.receiptNeedsReview = true;
              r.reason = 'confirmation_changed_after_delivery';
            }
            if (r.everPaid && !receipt.canFulfill && r.state !== 'delivered') {
              r.state = 'support_required';
              r.reason = 'confirmation_changed';
            }
          });
          return json(200, { ok: true });
        }
        if (req.method === 'GET' && u.pathname === '/internal/cases')
          return json(200, {
            cases: store
              .all()
              .filter(
                (o) =>
                  o.refundRequested ||
                  o.receiptNeedsReview ||
                  ['refund_review', 'support_required', 'refund_submitted'].includes(o.state),
              )
              .map((o) => ({
                id: o.id,
                state: o.state,
                reason: o.reason,
                refundAddress: o.refundAddress,
                refundTxid: o.refundTxid,
                refundRequested: o.refundRequested,
                receipt: reconcile(o, o.snapshot, now(), config.confirmations),
                audit: o.audit ?? [],
              })),
          });
        if (req.method === 'POST' && u.pathname === '/internal/refund-record') {
          const b = await body(req);
          const o = store.get(b.orderId);
          if (
            !o ||
            !o.refundRequested ||
            !b.actor ||
            b.actor.length > 80 ||
            !/^[a-f0-9]{64}$/i.test(b.txid ?? '') ||
            (o.refundTxid && o.refundTxid !== b.txid)
          )
            throw new InputError('Invalid refund record.');
          store.update(o.id, (r) => {
            r.state = 'refund_submitted';
            r.refundTxid = b.txid;
            r.audit = [
              ...(r.audit ?? []),
              { action: 'refund_submission_recorded', actor: b.actor, at: now(), txid: b.txid },
            ];
          });
          return json(200, { ok: true });
        }
        throw new InputError('Not found', 404);
      }
      if (u.pathname.startsWith('/api/')) {
        limited(ip + u.pathname, req.method === 'GET' ? 120 : 15);
        if (req.method === 'POST' && req.headers.origin !== config.origin)
          throw new InputError('Open checkout on the store website.', 403);
        if (req.method === 'GET' && u.pathname === '/api/config')
          return json(200, {
            giftCardProvider: config.giftCardProvider ?? '0fiat',
            network: config.network,
            checkoutReady: liveReady(),
            catalogPreview: catalogPreview(),
            catalogProvider: catalog.provider ?? '0fiat',
            emailAvailable: Boolean(config.resendKey && config.emailFrom),
            supportEmail: config.supportEmail,
            catalogUpdatedAt: catalog.fetchedAt,
            confirmations: config.confirmations,
            fundingMode: config.fundingMode ?? 'prepaid',
          });
        if (req.method === 'GET' && u.pathname === '/api/catalog') {
          const country = (u.searchParams.get('country') ?? 'US').slice(0, 3),
            search = (u.searchParams.get('q') ?? '').slice(0, 100).toLowerCase(),
            offset = Math.max(0, Math.min(20000, Number(u.searchParams.get('offset')) || 0));
          return json(
            200,
            catalogPage(
              config.giftCardProvider === 'cryptorefills' &&
                catalog.provider !== 'cryptorefills' &&
                !catalogPreview()
                ? []
                : catalog.vouchers,
              {
                country,
                search,
                offset,
                category: u.searchParams.get('category') ?? '',
              },
            ),
          );
        }
        if (req.method === 'POST' && u.pathname === '/api/orders') {
          if (!liveReady())
            throw new InputError('Checkout is being prepared. Please come back soon.', 503);
          const b = await body(req),
            v = catalog.vouchers.find((v) => v.voucherId === Number(b.voucherId));
          if (!v) throw new InputError('Gift card unavailable.');
          const faceAmount = validateFace(v, b.amount);
          const isCryptorefills = config.giftCardProvider === 'cryptorefills';
          if (
            isCryptorefills &&
            (config.fundingMode !== 'shielded_buffer' ||
              b.providerTermsAccepted !== true ||
              b.providerPrivacyAccepted !== true ||
              typeof b.email !== 'string' ||
              b.email.length > 254 ||
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))
          )
            throw new InputError(
              'Enter a delivery email and accept Cryptorefills terms and privacy policy.',
            );
          if (
            b.emailOptIn &&
            (!config.resendKey ||
              !config.emailFrom ||
              typeof b.email !== 'string' ||
              b.email.length > 254 ||
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))
          )
            throw new InputError('Enter a valid email address.');
          // Cryptorefills catalog/price responses require a reviewed normalizer.
          if (
            isCryptorefills &&
            typeof v.providerDenominations?.[faceAmount] !== 'string' &&
            v.denominationMode !== 'FLEXIBLE'
          )
            throw new InputError('Reviewed provider denomination unavailable.', 503);
          const q = isCryptorefills
            ? await provider.quoteProduct(v, faceAmount, {
                customerIp: ip,
                userAgent: req.headers['user-agent'],
              })
            : await provider.request(`/quote?voucherId=${v.voucherId}&amount=${faceAmount}`);
          if (Number(q.voucherId) !== v.voucherId || !new Decimal(q.faceAmount).eq(faceAmount))
            throw new InputError('Gift-card price changed. Try again.', 503);
          const r = await rate(),
            pricing = priceOrder(q, {
              rate: r.usd,
              rateAt: r.last_updated_at,
              now: now(),
              markupBps: config.markupBps,
              maxUsd: config.maxUsd,
            });
          const available =
            config.fundingMode === 'shielded_buffer' ? new Decimal(Infinity) : await balance();
          const reserved = store
            .all()
            .filter(
              (o) =>
                o.state === 'fulfilling' ||
                (o.state === 'delivered' && now() - (o.deliveredAt ?? now()) < 30) ||
                (![
                  'delivered',
                  'cancelled',
                  'refund_review',
                  'expired',
                  'refund_submitted',
                ].includes(o.state) &&
                  (o.expiresAt > now() || Boolean(o.snapshot?.receipts?.length))),
            )
            .reduce((n, o) => n.plus(o.costUsd), new Decimal(0));
          if (available.minus(reserved).lt(pricing.costUsd))
            throw new InputError(
              'This gift card is temporarily unavailable. No payment was requested.',
              503,
            );
          const order = {
            id: randomUUID(),
            giftCardProvider: config.giftCardProvider ?? '0fiat',
            providerProduct: isCryptorefills
              ? {
                  brand_name: v.brandName,
                  country_code: v.countryCode,
                  denomination:
                    v.denominationMode === 'FLEXIBLE'
                      ? 'range'
                      : v.providerDenominations[faceAmount],
                  ...(v.denominationMode === 'FLEXIBLE'
                    ? { product_value: Number(faceAmount) }
                    : {}),
                }
              : undefined,
            customerIp: isCryptorefills ? ip : undefined,
            providerConsent: isCryptorefills
              ? { terms: true, privacy: true, acceptedAt: now() }
              : undefined,
            voucherId: v.voucherId,
            brand: v.brandName,
            name: v.name,
            iconUrl: v.iconUrl,
            country: v.countryCode,
            currency: v.currency,
            faceAmount,
            ...pricing,
            recipient: config.recipient,
            network: config.network,
            state: 'quoted',
            fundingMode: config.fundingMode ?? 'prepaid',
            createdAt: now(),
            quoteExpiresAt: now() + 120,
            expiresAt: now() + 900,
            emailOptIn: b.emailOptIn === true,
            email: isCryptorefills || b.emailOptIn === true ? b.email : undefined,
          };
          const token = randomBytes(32).toString('base64url');
          if (order.fundingMode === 'shielded_buffer') {
            if (!isCryptorefills && new Decimal(order.costUsd).lt(10))
              throw new InputError('Buffered purchases require at least $10 provider cost.');
            try {
              validateShieldedAddress(config.recipient, config.network);
              order.paymentMemo = createPaymentMemo(order.id, b.replyAddress, config.network);
            } catch {
              throw new InputError('Enter a valid shielded reply address for this network.');
            }
            order.replyAddress = b.replyAddress;
            order.recoveryToken = token;
            order.settlement = { state: 'awaiting_receipt' };
          }
          store.insert(order, token);
          return json(201, { order: publicOrder(order), token });
        }
        const match = /^\/api\/orders\/([a-f0-9-]{36})(?:\/(pay|submitted|cancel|refund))?$/.exec(
          u.pathname,
        );
        if (match) {
          const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
          const o = store.authorized(match[1], token);
          if (!o) throw new InputError('Order not found. Use your saved order link.', 404);
          if (req.method === 'GET' && !match[2]) return json(200, { order: publicOrder(o) });
          if (req.method === 'POST') {
            const b = await body(req);
            store.update(o.id, (r) => {
              if (match[2] === 'pay') {
                if (r.state === 'payment_pending') return;
                if (r.state !== 'quoted' || now() >= r.quoteExpiresAt || !liveReady())
                  throw new InputError('This quote expired. Get a new quote.', 409);
                r.state = 'payment_pending';
                r.paymentStartedAt = now();
              } else if (match[2] === 'submitted') {
                if (!/^[a-f0-9]{64}$/i.test(b.txid ?? '') || r.state === 'quoted')
                  throw new InputError('Invalid submission');
                if (r.txid && r.txid !== b.txid) throw new InputError('Submission changed', 409);
                r.txid = b.txid;
              } else if (match[2] === 'cancel') {
                if (r.state !== 'quoted')
                  throw new InputError(
                    'Payment may already be underway. Check the order status.',
                    409,
                  );
                r.state = 'cancelled';
              } else if (match[2] === 'refund') {
                const receipt = reconcile(r, r.snapshot, now(), config.confirmations);
                if (
                  !['refund_review', 'support_required'].includes(r.state) &&
                  !['underpaid', 'overpaid', 'late_payment', 'reorg_review'].includes(receipt.state)
                )
                  throw new InputError('Contact support about this payment.');
                if (
                  typeof b.address !== 'string' ||
                  b.address.length > 512 ||
                  !b.address.startsWith(r.network === 'mainnet' ? 'u1' : 'utest1')
                )
                  throw new InputError('Enter a Zcash unified refund address.');
                r.refundAddress = b.address;
                r.refundRequested = true;
              } else throw new InputError('Not found', 404);
            });
            return json(200, { order: publicOrder(store.get(o.id)) });
          }
        }
        throw new InputError('Not found', 404);
      }
      throw new InputError('Not found', 404);
    } catch (e) {
      json(e instanceof InputError ? e.status : 503, {
        error:
          e instanceof InputError
            ? e.message
            : 'The store could not complete this request. Please try again.',
      });
    }
  };
  return {
    handler,
    async tick() {
      if (!config.fulfillmentEnabled) return;
      await settlement.tick();
      await cryptorefills.tick();
    },
    close: () => store.close(),
  };
}
