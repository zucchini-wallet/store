# Security

Do not put gift-card codes, API credentials, order capabilities, viewing keys, or
customer details in public issues. Report security issues privately to the repo
maintainer until a dedicated security address is configured.

No spending keys belong in this application. The scanner receives incoming
viewing authority only. The operator token can authorize receipt evidence and
must be treated as a financial authorization secret. Use separate production and
testing runtime secrets. A private order link is a bearer capability: its holder
can view the card. Restrict access to operator endpoints with Cloudflare Access
or equivalent private network controls in addition to the bearer token.

The Zcash lightwallet provider supplies canonical chain information. This is a
light-client trust model, not an independently operated consensus node.

Code is MIT licensed. The Zucchini logo is branding; its inclusion does not grant
trademark rights. Third-party gift-card artwork, catalog data and redemption
terms belong to their respective providers and brands and are not relicensed by
this repository.
