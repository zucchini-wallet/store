# Cryptorefills contract review — 9 October 2026

This record consolidates the authenticated dashboard review, public API reads and
linked provider guidance. It prevents treating omitted fields as verified API
contracts. Checkout and fulfillment remain disabled; no order, validation,
payment, KYC session, webhook registration or customer email was sent.

## Authenticated account and partner guide

Reviewed account, Overview, API, Orders and Webhooks in the user's authenticated
in-app browser. The partner is active, with terms accepted on 8 October 2026.
The public Partner ID was recorded for attribution; no secret value was read.
One active API key, no partner orders and no webhook endpoints were visible.

| Area            | Verified contract                                                                                                                     | Remaining gap                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Creation        | POST `/v6/partner/orders`; private partner-key header; stable external order ID makes retries idempotent; customer IP header required | Full success JSON schema and field types                                                   |
| Product/payment | Request binds brand, country, denomination, customer email; documented USDC/Solana USER_WALLET request                                | Actual invoice amount, precise recipient semantics, expiry and third-party swap acceptance |
| Polling         | GET `/v6/partner/orders/:id`; completed state required before delivery                                                                | Exact payment-accepted and delivery/code paths, immutable product/buyer evidence           |
| Cancellation    | DELETE same order path; idempotent cancelled/expired response; even partial payment blocks cancellation                               | Durable cancellation reconciliation in direct coordinator                                  |
| Late payment    | Dashboard offers order-ID rescan, then support if recovery fails                                                                      | No documented programmatic rescan contract                                                 |
| Errors          | 401 backup-key failover; 422 identity/product handling; 429 backoff                                                                   | Real partner error fixtures and actionable direct checkout UI                              |
| Identity        | Inline name/customer resource for identity-required products; hosted KYC separate                                                     | Initial direct route must exclude unsupported identity-required products                   |
| Webhooks        | Signed POST; deduplicate by webhook-id; ownership proof                                                                               | Signing format, complete event schema and replay/retry details; polling remains sufficient |
| Key operation   | At least two active privately stored keys; rotation and failover required                                                             | Backup key must be installed by the operator                                               |

Sources: [partner API](https://www.cryptorefills.com/en/account/partner/whitelabel/api),
[orders](https://www.cryptorefills.com/en/account/partner/whitelabel/orders),
[webhooks](https://www.cryptorefills.com/en/account/partner/whitelabel/webhooks).
The browser-local checklist is a reminder, not evidence of deployed readiness.

## Public read-only API evidence

The catalog module retains provider UUIDs and exact denominations. It does not
invent integer product identifiers. Native USDC on Solana is available in the
payment-via response, with six decimals. Product and price calls specifying only
`coin=USDC` returned `USDC-MATIC`; these prices cannot authorize a Solana invoice.
An unfiltered country product request returned 400; use an explicitly selected
family/brand, with a reviewed strategy for full category coverage.

The [integration guide](https://www.cryptorefills.com/en/api-docs/developers)
documents public catalog/price endpoints and v5 validations. Orders must represent
a genuine intended purchase; don't create unpaid orders just to discover schemas.
The v5 payment fields and thirty-minute window are not proof of v6 compatibility.
No validation request was made because it includes real customer data.

Cryptorefills' [Solana troubleshooting guide](https://www.cryptorefills.com/en/insights/solana-payment-common-error)
shows that a displayed payment address can be a USDC token account rather than
its wallet owner. Direct routing must independently resolve native mint, owner,
initialized account, canonical ATA and finalized context, and prove the swap
lands in the exact invoice account. Never derive an ATA using a token account as
the owner, or substitute the owner's address without this proof.

## Refund evidence and disclosure

The customer submits their own compatible address through a form linked in the
provider's refund email. The original payment coin/network applies, so eligible
crypto refunds after this route would be USDC/Solana. Some cases use coupons.
The claim expires after ninety days. The provider's source wallet is not the
customer's refund address. Confirm that partner orders use the same customer
email/form recovery path; no reverse conversion to ZEC is promised.

Sources: [refund form](https://www.cryptorefills.com/en/help/refunds/submit-wallet),
[destination](https://www.cryptorefills.com/en/help/refunds/where-refunds-go),
[timing](https://www.cryptorefills.com/en/help/refunds/timeline),
[policy](https://www.cryptorefills.com/en/help/refunds/policy).

Swap failure and unused input are separate: the swap provider returns ZEC to the
customer's bound transparent Zcash address. Zucchini holds neither payment asset.

## Precise provider questions still needed

Request a versioned OpenAPI specification or redacted v6 creation/GET examples
covering both unpaid and completed gift-card orders, plus these confirmations:

1. Which fields bind invoice coin/network, exact atomic amount, address type and
   payment/confirmation deadline? Is the Solana deposit a canonical native-USDC
   ATA, and can its owner be used by an owner-address withdrawal protocol?
2. Does USER_WALLET accept an exact-output 1Click payout from a solver, rather than
   a transaction signed by the purchaser? Does it require a memo or payer binding?
3. How are paid, partial, late, expired, manual-review, delivery and refund states
   represented? Which delivery fields bind the email/product and contain the code?
4. Do v6 customer refunds use the customer's emailed address form with the same
   USDC/Solana currency, fees, timing and claim window as the public guidance?
5. How is the Solana network selected for pre-order prices and validations?

This is a draft request only. No message was sent to Cryptorefills.

## Code and next test boundary

`FUNDING_MODE=direct_swap` selects the intended route and reports its own blockers.
It cannot compose the merchant buffer/collector adapters or activate checkout.
Pure invoice/quote/address tests, read-only catalog tests and HTTP failover tests
establish local behavior only. Exact-output gateway preview remains distinct from
durable execution. Direct coordinator, renewable gateway sessions, wallet approval
expiry and verified response mappings must be completed before a capped real-funds
test. Funded acceptance precedes public activation, not local contract development.

Add the operator-created backup key without putting it in Wrangler vars:

```sh
npm exec wrangler -- secret put CRYPTOREFILLS_BACKUP_PARTNER_KEY
```

Keep the existing private key, encryption key and Durable Object identity intact.
