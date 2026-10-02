# Launch status — 2026-10-02

Store deployed at https://store.zucchinifi.xyz with browsing enabled and checkout,
fulfillment and scanner readiness disabled. Cloudflare Worker: zucchini-store.
The live authenticated health check returned provider HTTP 200, balance 0 USD,
and 16,408 unique catalog records. Runtime secrets and catalog are excluded from
Git. Source is public and MIT licensed; third-party artwork retains its rights.

Validation: 10 automated tests passed on Node 22.19.0, formatting passed,
production build and Wrangler dry run passed, and GitHub CI run 37015520585
succeeded. Browser checks covered desktop catalog search/product selection and a
390px viewport with no horizontal overflow. No paid provider order, Zcash
payment or email delivery has been performed.

Opening checkout still requires:

- Mainnet unified receiver, matching incoming-viewing-key file and scan birthday.
- Always-on supervised private receipt collector, caught up and monitored.
- Real operator fulfillment mailbox, support address and optional Resend sender/key.
- Funded 0fiat purse and one real end-to-end order with redeemable card recovery.
- Operational refund/support ownership, backups and monitoring; configure GitHub
  production environment deployment credentials for future manual releases.

The existing wallet, gateway, scanner SDK and dApp SDK repositories were not changed.
The store currently uses ordinary user-approved ZIP321 payments, not a production
verified-merchant registry endorsement.
