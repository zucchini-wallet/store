# Store operations

## Production setup

1. Create a dedicated receiving account in an existing Zucchini wallet. Keep its
   spending key in the wallet. Export its incoming viewing key to a private file.
   Choose a birthday before the first store payment. Rotating the receiver later
   requires a separately reviewed migration/scanner setup; do not change it while
   old invoices are payable. Set `MERCHANT_RECEIVER` to the exact same receiver
   in the Worker and scanner.
2. Configure the operator delivery mailbox (`FULFILLMENT_EMAIL`) and public
   support address. 0fiat requires a real deliverable email even when the buyer
   declines email. The provider receives the operator address only; Resend sends
   a copy to the buyer only after explicit opt-in.
3. Fund the 0fiat prepaid USD purse using its documented USDC/USDT deposit flow.
   Provider deposit minimums and network rules apply. Do not send ZEC directly to
   that provider deposit address. The store receives ZEC separately and the
   operator manages working capital. No automatic treasury conversion is built.
4. Prepare production secrets outside Git:
   `OFIAT_API_KEY`, `OFIAT_API_SECRET`, `DATA_ENCRYPTION_KEY` (32-byte random hex),
   `ADMIN_TOKEN` (at least 32 random characters), `RESEND_API_KEY`. Keep a secure
   recovery copy of the encryption key; losing it loses access to order/card data.
   Use separate secrets for test deployments. `.dev.vars`, `.env`, and `data/`
   are ignored. Never paste them into a public issue.
5. Configure a verified `EMAIL_FROM` sender in Resend. Configure `FULFILLMENT_EMAIL`
   and `SUPPORT_EMAIL` as Worker vars. Configure `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` in the GitHub production environment for later manual
   deployments. The CLI's local OAuth can perform the initial deployment.
6. Deploy with `CHECKOUT_ENABLED=false`, `FULFILLMENT_ENABLED=false`,
   `SCANNER_READY=false`, build assets and publish the cached catalog.

```sh
npm run build
npm exec wrangler -- deploy
npm exec wrangler -- secret bulk /absolute/private/store-runtime.json
node scripts/catalog-publish.mjs https://store.zucchinifi.xyz \
  /absolute/private/store-runtime.json /absolute/private/catalog.json
```

The catalog publisher sends only provider catalog records to the authenticated
store backend. Runtime JSON is read locally for the operator token, not uploaded
as a public asset. Nightly catalog refresh uses 83 calls for the current ~16k
catalog, below the documented 300/24h limit. Failed imports retain the prior
complete catalog. A catalog older than 48 hours prevents new checkout.

## Private receipt collector

Build the Rust binary from the public dapp-sdk `receipt-scanner` source with its
locked Cargo dependencies. Configure `.env` on an always-on operator host:
`SCANNER_BINARY`, `VIEWING_KEY_FILE`, `SCANNER_ENDPOINT`, `SCANNER_BIRTHDAY`,
`NETWORK`, `MERCHANT_RECEIVER`, `ADMIN_TOKEN`, and
`SCANNER_STORE_ORIGIN=https://store.zucchinifi.xyz`. Use mode 600 for key files
and mode 700 for the data directory. Run `npm run scan` under a supervisor with
restart and alerts. A laptop-only background process is not production uptime.
The collector owns a durable lock/checkpoint and rescan overlap, validates native
scanner output through the scanner SDK, preserves first-seen timestamps, and
sends complete per-order receipt snapshots. Reorgs discard noncanonical blocks
and rescan. The viewing key never goes to Cloudflare or to the browser.

The scanner keeps all watched receipts and blocks; budget disk and periodically
archive settled history through a reviewed retention migration. Do not delete
old receipts or first-seen timestamps ad hoc. A crash can leave a lock file:
verify the recorded PID is not running before removing that lock.

A scan heartbeat is accepted only after it catches up. It expires after 90
seconds, pausing new quotes/payments. A stale snapshot cannot authorize a new
provider purchase. Replay sequences and double-assigned receipt outputs fail.
The operator token is a trusted authority for receipt evidence; protect it with
private ingress/Cloudflare Access in addition to the application token.

## Activate

Set the mainnet receiver and confirmations (default 10), maximum order USD
(default 200), and markup (default 0 basis points). Run the scanner until caught
up; verify `/internal/health` using the operator token. Set all three readiness
flags true only after the receiver/viewing key is verified and provider funding
and email are tested. New quotes also reserve provider working capital against
open orders. Quotes expire after 2 minutes, and payment must be observed within
15 minutes of quote creation. The total includes the configured store markup;
the wallet network fee is separate. ZEC price data older than 120 seconds fails.

Manually complete a small funded order: Connect, Pay, confirmed receipt, provider
issuance, private card recovery after reload, and an optional email. Confirm the
card can be redeemed. Rehearse cancellation, provider timeout recovery, scanner
outage, quote expiry and refund support. Do not claim live acceptance from mock
fixture tests. Keep checkout closed if any gate fails.

## Provider recovery and refunds

A payment's order ID is the immutable 0fiat `clientOrderId`. Before purchase,
recheck the price and reject increases above the customer total. Persist the
fulfillment state before calling 0fiat. On timeout/crash, check
`clientOrderIdStatus`; retry create only with the same ID. Never edit a paid
order's voucher/amount or allocate a replacement provider ID. Monitor the
provider's actual `payableAmount` and gift-card details on the funded acceptance
test; unexpected schemas fail into support instead of issuing a fake success.

A provider `failed`/`refunded` status becomes `refund_review`. USD returning to
0fiat is not a Zcash customer refund. The customer submits a unified refund
address through their private order capability. Review `/internal/cases`.
Verify the address and payment, and send the refund using the operator wallet.
Then POST `/internal/refund-record` with `{orderId,txid,actor}` using the operator
token. This records submission, not chain confirmation, and cannot transfer
funds. Keep the support case until wallet confirmation is verified. Underpaid,
overpaid, late and reorg cases require manual review. An already issued card
cannot be reissued to make a receipt inconsistency disappear.

## Email and privacy

Email has its own persistent delivery attempt and `gift-card/<order-id>` Resend
idempotency key. Stop automatic retry before the 24-hour deduplication window;
review `emailNeedsReview` orders rather than risk another delivery. A successful
API response means accepted for email delivery, not proof the inbox received it.
The card is always recoverable on the private order page after fulfillment.

No analytics, ads, sale of data or customer signup is included. Brand images
load from 0fiat and disclose the visitor IP to that host. Incoming viewing
keys cover their wallet account; use account scope intentionally. Data encryption
protects stored customer/card JSON but does not replace operator access control.
Back up durable order state and the encryption key separately. Establish business
retention/support policies before opening checkout. Future deletion tooling must
preserve financial reconciliation obligations without erasing required receipts.

## Health and deployment

- Cloudflare alarms recover pending order/provider/email work every 15 seconds.
- The scheduled daily refresh retains the prior catalog on provider errors.
- `/internal/health` reports sanitized connectivity, balance, catalog and scanner
  freshness. Protect it with the operator token; do not publish that token.
- Monitor refund, price-change, email-review, stale-scanner and catalog-refresh
  cases. External paging/on-call delivery must be configured by the operator.
- Disable checkout flags to pause new payments without deleting paid orders.
  Keep receipt collection/status recovery running for outstanding orders.
- Production Worker deployment is manual. CI push/PR checks never purchase cards,
  send email or publish production secrets.
