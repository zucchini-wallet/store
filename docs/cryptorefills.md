# Cryptorefills partner integration — local, disabled

The authenticated partner guide was reviewed on 8 October 2026:
- https://www.cryptorefills.com/en/account/partner/whitelabel/api
- https://www.cryptorefills.com/en/account/partner/whitelabel/webhooks
- https://www.cryptorefills.com/en/api-docs/developers

## Local implementation

`GIFT_CARD_PROVIDER=cryptorefills` selects the new disclosures in browse-only mode.
`loadConfig` rejects enabled Cryptorefills checkout. Server and Worker do not load 0fiat credentials for this selection. They now
compose Cryptorefills through the private CRYPTOREFILLS_PARTNER_KEY environment
binding. Runtime construction performs no network request.
No credentials, service calls, account changes, orders or transfers were used to
implement or test this integration. Preexisting 0fiat behavior remains the default;
changing the configuration does not reinterpret existing orders.

The local injectable flow is:

confirmed shielded ZEC → existing gateway conversion → confirmed merchant-buffer
USDC → create partner order → approve exact order payment → finalized Solana
payment evidence → poll partner delivery → private recovery page / shielded reply.

`cryptorefills-provider.mjs` implements documented POST/GET/DELETE partner order
requests, stable `external_order_id`, real delivery email and required
`X-CR-Forwarded-For`. The HTTP client returns raw responses. It does not fabricate
v6 response fields or enable KYC-required products. No newsletter flag is sent.
Cancellation is exposed on the client only; paid store orders are not automatically
cancelled. Cryptorefills refuses cancellation after any payment is detected.

`cryptorefills-settlement.mjs` persists order creation before its side effect and
recovers by retrying the identical external order ID. It validates the order's
recipient, asset, amount and deadline before building a wallet plan. A stable
provider ID cannot be assigned to another purchase. A signing attempt is persisted
before wallet approval and cannot be repeated after ambiguity. Payment txids require
independent finalized transfer evidence, and cannot be reused across orders.
Delivery must match provider/store IDs, buyer, brand, country and face amount before
card data is stored in the existing encrypted database.

The Solana builder now has `prepareSolanaUsdcPayment` for positive per-order
payments; `prepareSolanaUsdcTopup` keeps 0fiat's $10 minimum. Both use the same
native USDC, canonical account and unsigned TransferChecked checks. Provider payment
addresses must be verified as wallet-owner addresses before using the existing ATA
builder: a token-account address is not interchangeable with its owner.

## Adapter contract (internal, NOT an asserted provider response schema)

A local simulation composes `createApp` using disabled-runtime configuration,
`settlementAdapters` for gateway/buffer/outgoing-reply evidence, and
`cryptorefillsAdapters` for the provider payment stage. `runtime-settlement.mjs` now composes the documented HTTP client, gateway session
and read-only Solana RPC transport when their bindings are supplied. Reviewed
v6 mapping functions and account-scoped reply verification are still absent, so
the default runtime cannot initiate Cryptorefills purchases. All methods fetch authoritative inputs themselves in any future live adapter.

- `provider.quoteProduct(voucher, faceAmount)` returns the existing bounded USD quote
  contract: voucherId, faceAmount, currency=USD, payableAmount. The CoinGecko invoice
  pricing remains; an executable conversion must cover cost and configured margin.
- Catalogs must identify `provider: cryptorefills`; normalized fixed vouchers map
  `providerDenominations[faceAmount]` to the exact provider denomination. Flexible
  vouchers use `range` with product_value. Never relabel an old 0fiat catalog.
- `cryptorefillsAdapters.createOrder(order)` calls the documented client and maps
  a reviewed response to `{externalOrderId, orderId, state: WAITING_FOR_PAYMENT,
  coin: USDC, network: Solana, recipient, amountAtomic, expiresAt}`. Amount is a
  positive six-decimal atomic string; deadline is Unix seconds. The order price
  cannot exceed the authorized provider cost. On retry, the same provider ID,
  destination and amount must remain bound.
- `prepareTopup(order, settlement)` uses `order.providerPayment`, the buffer account,
  approved fee cap and existing-account policy with `prepareSolanaUsdcPayment`.
- `verifyTopup(order, settlement)` checks finalized canonical native USDC evidence
  using the existing Solana verifier, returning exact txid/from/to/amount/token/network.
- `getOrder(order)` maps a reviewed status to the internal status vocabulary and
  immutable IDs. `COMPLETED` requires `delivery: {beneficiary, brand, country,
  faceAmount, card}`. `REFUNDED`, expiry, failure and manual review route to refund
  review. Unknown states block progression. A provider refund does not issue ZEC.

The `/internal/settlement` endpoint dispatches provider payment actions according
to the order's stored provider, while conversion and shielded replies use the
existing coordinator. The operator page now discovers registered Wallet Standard wallets through the
maintained @wallet-standard/app package, requires explicit wallet selection and
approval, and reads canonical block height from the authenticated Worker endpoint.
It can approve only the persisted per-order plan and exact buffer account. `check_delivery` polls delivery. Background ticks
advance safe reads/order recovery; signing always requires the operator.

## Verified requirements and remaining activation work

Partner creation uses `/v6/partner/orders` and `X-CR-Partner-Key`.
`external_order_id` is documented as idempotent. Customer IP forwarding is mandatory.
The checkout displays Cryptorefills as seller/delivery provider, requests the real
email, and requires separate unchecked terms/privacy acceptances. Incoming source
IP comes from the server transport; do not trust arbitrary forwarded headers. The
Worker's Cloudflare client-IP handling must retain its platform trust boundary.

The public `/v5` reference documents wallet_address/coin_amount, a 30-minute window,
and code availability at Done. The partner guide uses WAITING_FOR_PAYMENT/COMPLETED
but does not give the full v6 payment/delivery schema. Exact response mappings,
recipient-owner semantics, price/catalog normalization, and any v6 validation/SSE
support must be verified before live wiring. No v5 shape is assumed for v6.

The webhook page documents signed events, deduplication on webhook-id and endpoint
ownership proof. No endpoint exists in the inspected account. No webhook was
registered; signature format, event schema, retries and replay policy remain
unverified. Polling is the implemented local status path.

Before activation confirm permission for merchant-buffer payment on customers'
behalf, conversion charges/markup, partial/late/expired payments, refund currency,
refund destination, and refund liquidity. Review required provider branding and
full category display against the partner agreement before launch. Product/KYC
limits must be handled explicitly; the current local path does not provision KYC.
The provider creates orders only after conversion funds reach the buffer, reducing
payment-window pressure; expired orders still require explicit reconciliation.

Tests use synthetic requests/responses, addresses and chain data. They prove local
bindings and recovery behavior, not real API interoperability or funded delivery.

## Cloudflare configuration and secrets

`wrangler.jsonc` now selects Cryptorefills and shielded-buffer settlement on the
native Solana USDC route. Checkout, fulfillment and scanner readiness remain
false. Existing Durable Object identity and encryption keys must be retained.
The operator added CRYPTOREFILLS_PARTNER_KEY; its presence was confirmed by
secret name only. No key value was read or printed. ADMIN_TOKEN,
DATA_ENCRYPTION_KEY and existing 0fiat secrets remain in place.

Add a private key using the existing authenticated Wrangler session:

```sh
npm exec wrangler -- secret put CRYPTOREFILLS_PARTNER_KEY
```

Do not add private values to wrangler vars. Remaining transport settings are
GATEWAY_ORIGIN and private GATEWAY_SESSION_TOKEN, approved SOLANA_RPC_URL, exact
BUFFER_ADDRESS, CONVERSION_REFUND_ADDRESS, SOLANA_MAX_FEE_LAMPORTS and the
existing-account SOLANA_MAX_RENT_LAMPORTS=0 policy. A dedicated RPC URL containing
a provider token belongs in a secret binding. No private values, fee budgets or
merchant wallets were invented. The seed/viewing key remains with the private
collector rather than the Worker.

`/internal/health` now reports sanitized runtimeReadiness with individual blockers
and never treats credential presence as verified provider connectivity. Provider
identity survives catalog publication/storage/reload; a mismatched catalog cannot
authorize checkout. The old 0fiat catalog remains available as an explicitly labelled preview only
while checkout is disabled. A reviewed Cryptorefills catalog is required before
any purchase can be authorized.

`solana-rpc.mjs` makes bounded finalized RPC reads, validates mainnet genesis,
existing USDC accounts, balances and fee estimates, then reconstructs the exact
unsigned transaction. Confirmed outgoing transfers must match the entire approved
message, fee, accounts and instruction. There is no signing or broadcast method.

Current runtime tests and transport tests use synthetic fetch and wallet inputs.
Response mapping, merchant payment/refund permission, account-scoped outgoing ZEC
verification, catalog compatibility and funded acceptance remain activation gates.

## Cloudflare version prepared on 8 October 2026

Uploaded Worker version `226bd03d-a209-4db1-a2de-dcfe8c62efcb`, tagged
`cryptorefills-prep`, with checkout/fulfillment/scanner disabled and existing
variables/secrets preserved. This upload did not move production traffic or
change routes/triggers. This initial preparation version would hide the legacy catalog. The subsequent
release adds an explicitly labelled, read-only 0fiat catalog preview while
checkout is disabled; a matching Cryptorefills catalog remains a purchase gate.

Validation: 48 tests passed on verified Node 22.19.0; formatting, frontend build,
Worker dry run and Cloudflare upload/startup validation passed. All provider,
RPC and wallet tests used synthetic inputs. No provider purchase, ZEC/Solana
payment, email or live funded acceptance was performed.

## Disabled production rollout on 9 October 2026

The release preserves existing catalog browsing as a labelled 0fiat preview and
keeps checkout, fulfillment and scanner-readiness flags false. Cryptorefills
provider configuration and private key binding are present. Response/catalog
mappings, merchant account/gateway/RPC inputs and the existing activation gates
still prevent payments.
