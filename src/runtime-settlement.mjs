import { createCryptorefillsProvider } from './cryptorefills-provider.mjs';
import { createGatewayAdapter } from './gateway-adapter.mjs';
import { createSolanaRpc } from './solana-rpc.mjs';
import { SOLANA_USDC, verifySolanaTransferEvidence } from './solana-settlement.mjs';
import { createGatewaySession } from './gateway-session.mjs';
import { createDirectGatewayAdapter } from './direct-gateway-adapter.mjs';

// Construct transports only; this function never calls a service or submits funds.
// Reviewed response mappings are source functions, not environment-provided code.
export function createRuntimeSettlement({ config, env, fetcher = fetch, mappings, verifyReply }) {
  const keyConfigured =
    typeof env.CRYPTOREFILLS_PARTNER_KEY === 'string' &&
    Boolean(env.CRYPTOREFILLS_PARTNER_KEY.trim());
  const backupKeyConfigured =
    typeof env.CRYPTOREFILLS_BACKUP_PARTNER_KEY === 'string' &&
    Boolean(env.CRYPTOREFILLS_BACKUP_PARTNER_KEY.trim()) &&
    env.CRYPTOREFILLS_BACKUP_PARTNER_KEY !== env.CRYPTOREFILLS_PARTNER_KEY;
  if (config.fundingMode === 'direct_swap') {
    // A selection is not a funded implementation. Never compose the merchant
    // buffer, scanner, Solana signer, or outgoing ZEC adapters for direct orders.
    const solanaConfigured = Boolean(config.solanaRpcUrl);
    const rpc = solanaConfigured
      ? createSolanaRpc({ url: config.solanaRpcUrl, fetcher })
      : undefined;
    const gatewayConfigured = Boolean(
      config.gatewayOrigin && config.gatewayAppId && env.GATEWAY_INSTALLATION_SEED,
    );
    const schemaConfigured =
      mappings?.contract === 'cryptorefills-partner-v6-reviewed' &&
      ['directPrice', 'directInvoice', 'directOrder', 'directCancel'].every(
        (name) => typeof mappings[name] === 'function',
      );
    const rawProvider = keyConfigured
      ? createCryptorefillsProvider(
          {
            key: env.CRYPTOREFILLS_PARTNER_KEY,
            ...(backupKeyConfigured ? { backupKey: env.CRYPTOREFILLS_BACKUP_PARTNER_KEY } : {}),
          },
          { fetcher },
        )
      : undefined;
    const session = gatewayConfigured
      ? createGatewaySession({
          origin: config.gatewayOrigin,
          installationSeed: env.GATEWAY_INSTALLATION_SEED,
          appId: config.gatewayAppId,
          fetcher,
        })
      : undefined;
    const gateway = session
      ? createDirectGatewayAdapter({
          origin: config.gatewayOrigin,
          session,
          slippageBps: config.slippageBps,
          fetcher,
        })
      : undefined;
    const directAdapters =
      rawProvider && schemaConfigured && rpc && gateway
        ? {
            createInvoice: async (order) =>
              mappings.directInvoice(await rawProvider.createOrder(order), order),
            getInvoice: async (order) =>
              mappings.directOrder(
                await rawProvider.getOrder(order.direct.providerOrderId, order.customerIp),
                order,
              ),
            cancelInvoice: async (order) =>
              mappings.directCancel(
                await rawProvider.cancelOrder(order.direct.providerOrderId, order.customerIp),
                order,
              ),
            readInvoiceAccount: (invoice) => rpc.readInvoiceAccount(invoice),
            ...gateway,
            async verifyPayout(binding, txid) {
              return verifySolanaTransferEvidence(await rpc.readTransferEvidence(txid), {
                txid,
                to: binding.recipientAddress,
                amountAtomic: binding.amountOutAtomic,
                destinationAccount: binding.destinationAccount,
              });
            },
          }
        : undefined;
    const blockers = [];
    if (!keyConfigured) blockers.push('cryptorefills_partner_key');
    if (!backupKeyConfigured) blockers.push('cryptorefills_backup_partner_key');
    if (!config.cryptorefillsPartnerId) blockers.push('cryptorefills_public_partner_id');
    if (!solanaConfigured) blockers.push('solana_invoice_account_rpc');
    if (!schemaConfigured) blockers.push('reviewed_v6_invoice_price_and_delivery_mappings');
    if (!gatewayConfigured) blockers.push('gateway_installation_seed_origin_and_allowlisted_app');
    blockers.push(
      'gateway_exact_output_route_review_and_deployment',
      'swap_recipient_matches_invoice_token_account',
      'quote_deadline_wallet_release',
      'cryptorefills_direct_swap_and_customer_refund_confirmation',
      'funded_acceptance',
    );
    return {
      runtimeReadiness: Object.freeze({
        fundingMode: 'direct_swap',
        keyConfigured,
        backupKeyConfigured,
        solanaConfigured,
        gatewayConfigured,
        schemaConfigured,
        coordinatorImplemented: true,
        readyForFundsTest: false,
        checkoutActivatable: false,
        blockers,
      }),
      directAdapters,
      provider:
        rawProvider && schemaConfigured
          ? {
              quoteProduct: (voucher, amount, context) =>
                mappings.directPrice({ voucher, amount, context, fetcher }),
            }
          : undefined,
      getSolanaBlockHeight: rpc ? () => rpc.getCurrentBlockHeight() : undefined,
    };
  }
  const gatewayConfigured = Boolean(config.gatewayOrigin && env.GATEWAY_SESSION_TOKEN);
  const solanaConfigured = Boolean(
    config.solanaRpcUrl &&
      config.bufferAddress &&
      config.solanaMaxFeeLamports &&
      config.solanaMaxRentLamports === '0',
  );
  const schemaConfigured = ['quoteProduct', 'payment', 'delivery'].every(
    (name) => typeof mappings?.[name] === 'function',
  );
  const rawProvider = keyConfigured
    ? createCryptorefillsProvider(
        {
          key: env.CRYPTOREFILLS_PARTNER_KEY,
          ...(backupKeyConfigured ? { backupKey: env.CRYPTOREFILLS_BACKUP_PARTNER_KEY } : {}),
        },
        { fetcher },
      )
    : undefined;
  const rpc = solanaConfigured ? createSolanaRpc({ url: config.solanaRpcUrl, fetcher }) : undefined;
  const gateway = gatewayConfigured
    ? createGatewayAdapter({
        origin: config.gatewayOrigin,
        session: async () => env.GATEWAY_SESSION_TOKEN,
        config,
        fetcher,
      })
    : undefined;
  const blockers = [];
  if (!keyConfigured) blockers.push('cryptorefills_partner_key');
  if (!schemaConfigured) blockers.push('reviewed_v6_response_and_price_mappings');
  if (!gatewayConfigured) blockers.push('merchant_gateway_session');
  if (!solanaConfigured) blockers.push('solana_rpc_buffer_and_fee_policy');
  if (typeof verifyReply !== 'function') blockers.push('account_scoped_outgoing_zcash_adapter');
  // Commercial/acceptance gates cannot be satisfied by an environment flag.
  blockers.push('merchant_buffer_payment_and_refund_policy', 'funded_acceptance');
  const runtimeReadiness = Object.freeze({
    keyConfigured,
    gatewayConfigured,
    solanaConfigured,
    schemaConfigured,
    checkoutActivatable: false,
    blockers,
  });
  const provider =
    rawProvider && schemaConfigured
      ? {
          quoteProduct: (voucher, amount, context) =>
            mappings.quoteProduct({ voucher, amount, context, fetcher }),
        }
      : undefined;
  // Expose only a complete stage; partial composition cannot advance paid orders.
  const cryptorefillsAdapters =
    rawProvider && schemaConfigured && rpc
      ? {
          createOrder: async (order) =>
            mappings.payment(await rawProvider.createOrder(order), order),
          getOrder: async (order) =>
            mappings.delivery(
              await rawProvider.getOrder(order.providerOrderId, order.customerIp),
              order,
            ),
          prepareTopup: (order) =>
            rpc.preparePayment({
              from: config.bufferAddress,
              to: order.providerPayment.recipient,
              amountAtomic: order.providerPayment.amountAtomic,
              maxFeeLamports: config.solanaMaxFeeLamports,
              maxRentLamports: config.solanaMaxRentLamports,
            }),
          verifyTopup: (_order, s) => rpc.verifyTopup(s.topupPlan, s.topupTxid),
        }
      : undefined;
  const settlementAdapters =
    gateway && rpc
      ? {
          ...gateway,
          async verifyBufferReceipt(_order, s, result) {
            const matches = [];
            const references = [
              ...new Set((result.destinationTransactions ?? []).map((t) => t.hash)),
            ];
            if (!references.length || references.length > 10)
              throw Error('Conversion output references unavailable');
            for (const txid of references) {
              const bundle = await rpc.readTransferEvidence(txid),
                tx = bundle.transaction;
              const instructions = [
                ...(tx?.transaction?.message?.instructions ?? []),
                ...(tx?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
              ];
              const amounts = new Set(
                instructions
                  .filter(
                    (i) =>
                      i.programId === SOLANA_USDC.program &&
                      i.parsed?.type === 'transferChecked' &&
                      i.parsed.info?.mint === SOLANA_USDC.mint,
                  )
                  .map((i) => i.parsed.info.tokenAmount?.amount),
              );
              for (const amountAtomic of amounts) {
                if (
                  !/^[1-9][0-9]{0,19}$/.test(amountAtomic ?? '') ||
                  BigInt(amountAtomic) < BigInt(s.quote.minimumOutputAtomic)
                )
                  continue;
                try {
                  matches.push(
                    verifySolanaTransferEvidence(bundle, {
                      txid,
                      to: config.bufferAddress,
                      amountAtomic,
                    }),
                  );
                } catch {
                  /* Unrelated transfer cannot establish credited output. */
                }
              }
            }
            if (matches.length !== 1) throw Error('Conversion output missing or ambiguous');
            return matches[0];
          },
          ...(typeof verifyReply === 'function' ? { verifyReply } : {}),
        }
      : undefined;
  return {
    provider,
    cryptorefillsAdapters,
    settlementAdapters,
    runtimeReadiness,
    getSolanaBlockHeight: rpc ? () => rpc.getCurrentBlockHeight() : undefined,
  };
}
