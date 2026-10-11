import {
  CRYPTOREFILLS_DIRECT_PRICE_POLICY,
  validateCryptorefillsCatalogRecord,
} from './cryptorefills-catalog.mjs';

export function catalogProvider(value = '0fiat') {
  if (!['0fiat', 'cryptorefills'].includes(value)) throw Error('Invalid catalog provider');
  return value;
}
const categories = {
  shopping: /amazon|walmart|target|ikea|adidas|nike|fashion|hardware|department|flipkart|myntra/i,
  food: /restaurant|food|pizza|burger|coffee|starbucks|dunkin|dining|grill|doordash|ubereats|zomato|swiggy|pub|subway/i,
  gaming: /game|gaming|steam|playstation|xbox|nintendo|roblox|razer/i,
  travel: /travel|hotel|airbnb|airalo|flight|airline|uber|lyft|booking|cruise/i,
};
/** Provider-scoped string keys work in TEXT storage without numeric UUID coercion. */
export function catalogRecordKey(record, provider = record?.provider ?? '0fiat') {
  catalogProvider(provider);
  if (provider === 'cryptorefills') return validateCryptorefillsCatalogRecord(record).id;
  if (
    !record ||
    !Number.isSafeInteger(record.voucherId) ||
    (record.provider != null && record.provider !== '0fiat') ||
    record.providerProductId != null ||
    record.providerBrandId != null
  )
    throw Error('Invalid legacy catalog identity');
  return `0fiat:${record.voucherId}`;
}

export function cleanCatalog(vouchers, provider = '0fiat') {
  catalogProvider(provider);
  if (!Array.isArray(vouchers) || vouchers.length > 50000) throw Error('Invalid catalog');
  const byId = new Map();
  for (const input of vouchers) {
    const v = provider === 'cryptorefills' ? validateCryptorefillsCatalogRecord(input) : input;
    if (
      !v ||
      !v.brandName ||
      !v.currency ||
      !v.countryCode ||
      !['FIXED', 'FLEXIBLE'].includes(v.denominationMode)
    )
      throw Error('Invalid catalog record');
    const key = catalogRecordKey(v, provider);
    const old = byId.get(key);
    if (old && JSON.stringify(old) !== JSON.stringify(v))
      throw Error('Conflicting catalog records');
    byId.set(key, v);
  }
  return [...byId.values()];
}

/** Validate cache/import metadata separately from executable provider pricing. */
export function cleanCatalogDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid catalog document');
  const provider = catalogProvider(input.provider);
  if (typeof input.fetchedAt !== 'string' || !Number.isFinite(Date.parse(input.fetchedAt)))
    throw Error('Invalid catalog timestamp');
  const vouchers = cleanCatalog(input.vouchers, provider);
  if (provider === '0fiat') return { ...input, provider, vouchers };
  const policy = input.directPrice;
  if (
    !policy ||
    typeof policy !== 'object' ||
    Array.isArray(policy) ||
    Object.keys(policy).length !== Object.keys(CRYPTOREFILLS_DIRECT_PRICE_POLICY).length ||
    Object.entries(CRYPTOREFILLS_DIRECT_PRICE_POLICY).some(([key, value]) => policy[key] !== value)
  )
    throw Error('Cryptorefills catalog requires unverified invoice-based pricing');
  if (
    Object.keys(input).some(
      (key) =>
        !['provider', 'fetchedAt', 'vouchers', 'directPrice', 'selectionScope'].includes(key),
    )
  )
    throw Error('Unsupported Cryptorefills catalog metadata');
  let selectionScope;
  if (input.selectionScope != null) {
    if (input.selectionScope !== 'selected_families')
      throw Error('Invalid catalog selection scope');
    selectionScope = input.selectionScope;
  }
  return {
    provider,
    fetchedAt: input.fetchedAt,
    vouchers,
    directPrice: { ...CRYPTOREFILLS_DIRECT_PRICE_POLICY },
    ...(selectionScope ? { selectionScope } : {}),
  };
}

export function validateCatalogPublication(
  input,
  { provider, previewOnly = false, now = Date.now() } = {},
) {
  const catalog = cleanCatalogDocument(input);
  if (provider != null && catalog.provider !== catalogProvider(provider))
    throw Error('Catalog provider mismatch');
  const age = now - Date.parse(catalog.fetchedAt);
  if (!Number.isFinite(now) || age < -300000 || age >= 48 * 3600000 || !catalog.vouchers.length)
    throw Error('A complete fresh catalog is required for publication');
  if (catalog.provider === 'cryptorefills' && previewOnly !== true)
    throw Error('Cryptorefills catalog can only be published as a preview');
  return catalog;
}
export function catalogPage(vouchers, { country, search = '', category = '', offset = 0 }) {
  const groups = new Map();
  for (const v of vouchers) {
    if (
      v.countryCode !== country ||
      (search && !`${v.name ?? ''} ${v.brandName}`.toLowerCase().includes(search.toLowerCase())) ||
      (categories[category] && !categories[category].test((v.name ?? '') + ' ' + v.brandName))
    )
      continue;
    const safe = {
      ...(v.provider === 'cryptorefills'
        ? {
            id: v.id,
            provider: 'cryptorefills',
            providerProductId: v.providerProductId,
            available: v.available,
            checkoutEligible: false,
            networkVerified: false,
            ...(v.stepAmount == null ? {} : { stepAmount: v.stepAmount }),
          }
        : { voucherId: v.voucherId }),
      name: v.name,
      brandName: v.brandName,
      iconUrl: v.iconUrl,
      countryCode: v.countryCode,
      currency: v.currency,
      denominationMode: v.denominationMode,
      denominations: v.denominations ?? [],
      minAmount: v.minAmount,
      maxAmount: v.maxAmount,
    };
    const k =
      v.provider === 'cryptorefills'
        ? `cryptorefills|${v.providerBrandId}|${v.countryCode}|${v.currency}`
        : v.brandName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') + '|' + v.currency;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(safe);
  }
  const items = [...groups.values()].map((variants) => {
    variants.sort(
      (a, b) =>
        (a.denominationMode === 'FLEXIBLE' ? 0 : 1) - (b.denominationMode === 'FLEXIBLE' ? 0 : 1) ||
        Number(a.minAmount) - Number(b.minAmount),
    );
    return { ...variants[0], variants };
  });
  return {
    countries: [...new Set(vouchers.map((v) => v.countryCode))].sort(),
    total: items.length,
    items: items.slice(offset, offset + 36),
  };
}
