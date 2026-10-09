import { createCryptorefillsProvider } from './cryptorefills-provider.mjs';
import { createGatewayAdapter } from './gateway-adapter.mjs';
import { createSolanaRpc } from './solana-rpc.mjs';
import { SOLANA_USDC, verifySolanaTransferEvidence } from './solana-settlement.mjs';

// Construct transports only; this function never calls a service or submits funds.
// Reviewed response mappings are source functions, not environment-provided code.
export function createRuntimeSettlement({ config, env, fetcher = fetch, mappings, verifyReply }) {
  const keyConfigured =
    typeof env.CRYPTOREFILLS_PARTNER_KEY === 'string' &&
    Boolean(env.CRYPTOREFILLS_PARTNER_KEY.trim());
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
    ? createCryptorefillsProvider({ key: env.CRYPTOREFILLS_PARTNER_KEY }, { fetcher })
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
