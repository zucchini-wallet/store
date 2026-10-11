import { credentials } from '../src/credentials.mjs';
import { cleanCatalog, cleanCatalogDocument, catalogProvider } from '../src/catalog.mjs';
import {
  createCryptorefillsCatalogClient,
  CRYPTOREFILLS_DIRECT_PRICE_POLICY,
} from '../src/cryptorefills-catalog.mjs';
import { createProvider } from '../src/provider.mjs';
import { mkdir, writeFile, rename, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export function cleanCryptorefillsSelections(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50)
    throw Error('Select 1–50 reviewed provider families');
  const keys = new Set();
  return input.map((value) => {
    if (
      !value ||
      Object.keys(value).some((key) => !['countryCode', 'familyName'].includes(key)) ||
      !/^[A-Z]{2}$/.test(value.countryCode ?? '') ||
      typeof value.familyName !== 'string' ||
      !value.familyName.trim() ||
      value.familyName.length > 200
    )
      throw Error('Invalid catalog selection');
    const key = `${value.countryCode}:${value.familyName.toLowerCase()}`;
    if (keys.has(key)) throw Error('Duplicate catalog selection');
    keys.add(key);
    return { countryCode: value.countryCode, familyName: value.familyName };
  });
}

async function readJson(file, maxBytes) {
  if (!file || (await stat(file)).size > maxBytes) throw Error('Catalog input is too large');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function syncCatalog({
  argv = [],
  env = process.env,
  client,
  provider: legacyProvider,
  now = () => new Date().toISOString(),
} = {}) {
  const providerName = catalogProvider(env.GIFT_CARD_PROVIDER);
  let catalog;
  if (argv[0] === '--import' && argv.length === 2) {
    catalog = cleanCatalogDocument(await readJson(argv[1], 64 * 1024 * 1024));
    if (catalog.provider !== providerName) throw Error('Catalog import provider mismatch');
  } else if (providerName === 'cryptorefills') {
    if (argv.length !== 2 || argv[0] !== '--selection')
      throw Error(
        'Cryptorefills sync requires --selection <reviewed-country-family-json>; catalog stays preview-only',
      );
    const selections = cleanCryptorefillsSelections(await readJson(argv[1], 65536));
    const transport =
      client ?? createCryptorefillsCatalogClient({ applicationId: env.CRYPTOREFILLS_PARTNER_ID });
    // Availability metadata is not a quote or permission to activate checkout.
    await transport.getSolanaUsdc();
    const vouchers = [];
    for (const selection of selections) {
      const records = await transport.getProducts(selection);
      if (
        records.some(
          (record) =>
            record.countryCode !== selection.countryCode ||
            record.familyName.toLowerCase() !== selection.familyName.toLowerCase(),
        )
      )
        throw Error('Catalog response does not match the selected provider family');
      vouchers.push(...records);
    }
    catalog = cleanCatalogDocument({
      provider: 'cryptorefills',
      fetchedAt: now(),
      vouchers,
      directPrice: { ...CRYPTOREFILLS_DIRECT_PRICE_POLICY },
      selectionScope: 'selected_families',
    });
  } else {
    if (argv.length) throw Error('Usage: catalog-sync [--import <catalog-json>]');
    const transport = legacyProvider ?? createProvider(await credentials(env.OFIAT_ENV_FILE));
    const vouchers = [];
    for (let offset = 0; offset < 50000; offset += 200) {
      const result = await transport.request('/vouchers?limit=200&offset=' + offset);
      if (result.settlementCurrency !== 'USD' || !Array.isArray(result.vouchers))
        throw Error('Unexpected provider catalog');
      vouchers.push(...result.vouchers);
      if (result.vouchers.length < 200) break;
    }
    if (vouchers.length >= 50000) throw Error('Incomplete catalog');
    catalog = cleanCatalogDocument({
      provider: '0fiat',
      fetchedAt: now(),
      vouchers: cleanCatalog(vouchers, '0fiat'),
    });
  }
  if (!catalog.vouchers.length) throw Error('Empty catalog; previous cache retained');
  const directory = resolve(env.DATA_DIR ?? 'data'),
    target = resolve(directory, 'catalog.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = target + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(catalog), { mode: 0o600 });
  await rename(temporary, target);
  return catalog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const catalog = await syncCatalog({ argv: process.argv.slice(2) });
  console.log(
    `Cached ${catalog.vouchers.length} ${catalog.provider} gift cards.${catalog.provider === 'cryptorefills' ? ' Selected families only; preview prices are unverified for Solana.' : ' Refresh once daily.'}`,
  );
}
