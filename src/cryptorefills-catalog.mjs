import Decimal from 'decimal.js';

// Read-only endpoints documented at https://www.cryptorefills.com/en/api-docs/developers
// Fields were also observed in anonymous public GET responses on 9 October 2026.
const API_ORIGIN = 'https://api.cryptorefills.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LOGO_HOSTS = new Set(['cdn.cryptorefills.com', 'cryptorefills.s3-eu-west-1.amazonaws.com']);

function demand(condition, message) {
  if (!condition) throw Error(message);
}
function country(value) {
  demand(typeof value === 'string' && /^[A-Z]{2}$/.test(value), 'Invalid catalog country');
  return value;
}
function text(value, label, max = 200) {
  demand(typeof value === 'string' && value.trim().length > 0 && value.length <= max, label);
  return value;
}
function uuid(value) {
  demand(typeof value === 'string' && UUID.test(value), 'Invalid Cryptorefills UUID');
  return value.toLowerCase();
}
function positiveDecimal(value, maxDecimals = 6) {
  const raw = typeof value === 'number' ? String(value) : value;
  demand(typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw), 'Invalid catalog decimal amount');
  const amount = new Decimal(raw);
  demand(
    amount.isFinite() && amount.gt(0) && amount.decimalPlaces() <= maxDecimals,
    'Invalid catalog decimal amount',
  );
  return amount.toFixed();
}
function currency(value) {
  demand(typeof value === 'string' && /^[A-Z]{3}$/.test(value), 'Invalid catalog currency');
  return value;
}
function logo(value) {
  const url = new URL(value);
  demand(
    url.protocol === 'https:' && LOGO_HOSTS.has(url.hostname) && !url.username && !url.password,
    'Invalid Cryptorefills logo URL',
  );
  return url.href;
}
function brand(group, expectedCountry) {
  demand(group?.country_code === expectedCountry, 'Cryptorefills catalog country mismatch');
  demand(typeof group.is_out_of_stock === 'boolean', 'Missing catalog availability');
  return {
    provider: 'cryptorefills',
    providerBrandId: uuid(group.brand_id),
    brandName: text(group.brand, 'Missing exact provider brand'),
    familyName: text(group.family, 'Missing provider family'),
    countryCode: expectedCountry,
    iconUrl: logo(group.logo_url),
    available: !group.is_out_of_stock,
  };
}
function uniqueRecords(records, key) {
  const byId = new Map();
  for (const record of records) {
    const id = record[key];
    const existing = byId.get(id);
    demand(
      !existing || JSON.stringify(existing) === JSON.stringify(record),
      'Conflicting catalog IDs',
    );
    byId.set(id, record);
  }
  return [...byId.values()];
}

/** Gift-card brands only. Provider UUIDs remain explicit; no synthetic numeric voucher IDs. */
export function normalizeCryptorefillsBrands(raw, countryCode) {
  country(countryCode);
  demand(
    raw?.country_code === countryCode && Array.isArray(raw.all_brands),
    'Invalid brand catalog',
  );
  return uniqueRecords(
    raw.all_brands
      .filter((group) => group?.kind === 'giftcard')
      .map((group) => brand(group, countryCode)),
    'providerBrandId',
  );
}

/** Normalize fixed/range gift-card products. Catalog coin prices are deliberately excluded. */
export function normalizeCryptorefillsCatalog(raw, countryCode) {
  country(countryCode);
  demand(Array.isArray(raw), 'Invalid product catalog');
  const records = [];
  for (const group of raw) {
    if (group?.kind !== 'giftcard') continue;
    const common = brand(group, countryCode);
    demand(Array.isArray(group.products), 'Missing provider products');
    for (const product of group.products) {
      demand(typeof product?.is_dynamic === 'boolean', 'Missing denomination mode');
      demand(product.coin === 'USDC', 'Catalog is not priced in USDC');
      const providerProductId = uuid(product.product_id);
      const fiatCurrency = currency(product.face_value?.currency_code);
      const amount = product.face_value?.amount;
      const record = {
        ...common,
        id: `cryptorefills:${countryCode}:${providerProductId}`,
        providerProductId,
        currency: fiatCurrency,
        denominationMode: product.is_dynamic ? 'FLEXIBLE' : 'FIXED',
        providerDenomination: product.is_dynamic
          ? 'range'
          : text(product.denomination, 'Missing exact provider denomination', 100),
      };
      if (product.is_dynamic) {
        demand(
          amount?.type === 'range' && product.range?.currency === fiatCurrency,
          'Invalid range product',
        );
        const min = positiveDecimal(product.range.min);
        const max = positiveDecimal(product.range.max);
        demand(
          new Decimal(min).lte(max) &&
            new Decimal(min).eq(positiveDecimal(amount.min)) &&
            new Decimal(max).eq(positiveDecimal(amount.max)),
          'Conflicting range limits',
        );
        record.range = {
          min,
          max,
          ...(product.range.step_size == null
            ? {}
            : { step: positiveDecimal(product.range.step_size) }),
        };
      } else {
        demand(amount?.type === 'fixed', 'Invalid fixed product');
        record.faceValue = positiveDecimal(amount.price);
      }
      records.push(record);
    }
  }
  return uniqueRecords(records, 'id');
}

/** Current documented USER_WALLET/USDC/Solana metadata, requiring the native six-decimal mint. */
export function normalizeSolanaUsdcPaymentMethod(raw) {
  const exact = (items, name) => {
    demand(Array.isArray(items), 'Invalid payment-method catalog');
    const matches = items.filter((item) => item?.name === name);
    demand(matches.length === 1, 'Payment method is missing or ambiguous');
    return matches[0];
  };
  const method = exact(raw, 'USER_WALLET');
  const coin = exact(method.currencies, 'USDC');
  const network = exact(coin.networks, 'Solana');
  demand(method.available === true && coin.is_suspended === false, 'Solana USDC is unavailable');
  demand(
    network.smart_contract_engine === 'SVM' &&
      network.base_token === 'SOL' &&
      network.smart_contract?.engine === 'SVM' &&
      network.smart_contract.address === USDC_MINT &&
      network.smart_contract.decimals === 6 &&
      network.smart_contract.symbol === 'USDC',
    'Unexpected Solana USDC metadata',
  );
  return {
    paymentVia: 'USER_WALLET',
    coin: 'USDC',
    network: 'Solana',
    mint: USDC_MINT,
    decimals: 6,
    minimumCoinAmount: positiveDecimal(network.threshold, 18),
    available: true,
  };
}

/** This public currency-price response is not proof of a Solana settlement quote. */
export function normalizeCryptorefillsPrice(raw, expectedProductId) {
  const providerProductId = uuid(raw?.product_id);
  demand(providerProductId === uuid(expectedProductId), 'Provider price product mismatch');
  demand(raw.coin === 'USDC', 'Provider price currency mismatch');
  return {
    provider: 'cryptorefills',
    providerProductId,
    coin: 'USDC',
    coinAmount: positiveDecimal(raw.coin_amount),
    paymentMethod: text(raw.payment_method, 'Missing provider payment method', 80),
    networkVerified: false,
  };
}

function onlyKeys(value, names) {
  demand(value && typeof value === 'object' && !Array.isArray(value), 'Invalid catalog request');
  demand(
    Object.keys(value).every((key) => names.includes(key)),
    'Unsupported catalog request field',
  );
}
async function boundedJson(response, maxBytes) {
  demand(response.ok, `Cryptorefills catalog GET failed (${response.status})`);
  demand(
    /^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? ''),
    'Cryptorefills catalog response is not JSON',
  );
  const reader = response.body?.getReader();
  demand(reader, 'Empty Cryptorefills catalog response');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw Error('Cryptorefills catalog response is too large');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw Error('Invalid Cryptorefills catalog JSON');
  }
}

/** Serial, rate-limited public GETs only. No key, customer data, validation, orders, or payments. */
export function createCryptorefillsCatalogClient(
  config = {},
  {
    fetcher = fetch,
    now = () => performance.now(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 10000,
    maxResponseBytes = 8 * 1024 * 1024,
  } = {},
) {
  onlyKeys(config, ['applicationId', 'appVersion']);
  const { applicationId, appVersion = '0.1.0' } = config;
  demand(
    applicationId == null ||
      (typeof applicationId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(applicationId)),
    'Invalid public application ID',
  );
  demand(
    typeof appVersion === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(appVersion),
    'Invalid application version',
  );
  demand(
    typeof fetcher === 'function' && typeof now === 'function' && typeof wait === 'function',
    'Invalid GET transport',
  );
  demand(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000,
    'Invalid GET timeout',
  );
  demand(
    Number.isSafeInteger(maxResponseBytes) &&
      maxResponseBytes > 0 &&
      maxResponseBytes <= 8 * 1024 * 1024,
    'Invalid response limit',
  );
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Zucchini-Store-Catalog/0.1.0',
    'X-Cr-Version': appVersion,
    ...(applicationId ? { 'X-Cr-Application': applicationId } : {}),
  };
  let queue = Promise.resolve();
  let nextGetAt = 0;
  function get(path, query = {}) {
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(query))
      if (value != null) url.searchParams.set(key, value);
    const pending = queue.then(async () => {
      const delay = Math.max(0, nextGetAt - now());
      if (delay > 0) await wait(delay);
      nextGetAt = now() + 1000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(url.href, {
          method: 'GET',
          headers,
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        });
        return await boundedJson(response, maxResponseBytes);
      } finally {
        clearTimeout(timer);
      }
    });
    queue = pending.catch(() => {});
    return pending;
  }
  return Object.freeze({
    async getSolanaUsdc() {
      return normalizeSolanaUsdcPaymentMethod(await get('/v3/payment_vias'));
    },
    async getBrands(countryCode) {
      country(countryCode);
      return normalizeCryptorefillsBrands(
        await get('/v2/brands', { country_code: countryCode }),
        countryCode,
      );
    },
    async getProducts(input) {
      onlyKeys(input, ['countryCode', 'familyName', 'brandName']);
      country(input.countryCode);
      // The unfiltered country endpoint returned HTTP 400 on 9 October 2026.
      demand(
        input.familyName != null || input.brandName != null,
        'A provider brand or family filter is required',
      );
      if (input.familyName != null) text(input.familyName, 'Invalid provider family');
      if (input.brandName != null) text(input.brandName, 'Invalid provider brand');
      return normalizeCryptorefillsCatalog(
        await get(`/v5/products/country/${input.countryCode}`, {
          family_name: input.familyName,
          brand_name: input.brandName,
          coin: 'USDC',
          lang: 'en',
        }),
        input.countryCode,
      );
    },
    async getPrice(input) {
      onlyKeys(input, ['countryCode', 'brandName', 'faceValue', 'providerProductId']);
      country(input.countryCode);
      text(input.brandName, 'Invalid exact provider brand');
      uuid(input.providerProductId);
      const faceValue = positiveDecimal(input.faceValue);
      return normalizeCryptorefillsPrice(
        await get('/v4/products/price', {
          country_code: input.countryCode,
          brand_name: input.brandName,
          face_value: faceValue,
          coin: 'USDC',
        }),
        input.providerProductId,
      );
    },
  });
}
