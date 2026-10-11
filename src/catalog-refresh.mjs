import { cleanCatalogDocument, validateCatalogPublication } from './catalog.mjs';
import { CRYPTOREFILLS_DIRECT_PRICE_POLICY } from './cryptorefills-catalog.mjs';

// Refresh only the selected families already published. No order/customer calls,
// inferred checkout eligibility, or partial replacement of the active catalog.
export async function refreshSelectedCryptorefillsCatalog(catalog, { client, now = Date.now() }) {
  if (catalog?.provider !== 'cryptorefills' || catalog.selectionScope !== 'selected_families')
    throw Error('A selected Cryptorefills preview is required');
  const selections = new Map();
  for (const record of catalog.vouchers) {
    const key = `${record.countryCode}:${record.familyName.toLowerCase()}`;
    selections.set(key, { countryCode: record.countryCode, familyName: record.familyName });
  }
  if (!selections.size || selections.size > 50) throw Error('Invalid selected family count');
  await client.getSolanaUsdc();
  const vouchers = [];
  for (const selection of selections.values()) {
    const records = await client.getProducts(selection);
    if (
      records.some(
        (record) =>
          record.countryCode !== selection.countryCode ||
          record.familyName.toLowerCase() !== selection.familyName.toLowerCase(),
      )
    )
      throw Error('Catalog response does not match selected family');
    vouchers.push(...records);
  }
  return validateCatalogPublication(
    cleanCatalogDocument({
      provider: 'cryptorefills',
      fetchedAt: new Date(now).toISOString(),
      vouchers,
      selectionScope: 'selected_families',
      directPrice: { ...CRYPTOREFILLS_DIRECT_PRICE_POLICY },
    }),
    { provider: 'cryptorefills', previewOnly: true, now },
  );
}
