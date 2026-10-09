import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCryptorefillsBrands,
  normalizeCryptorefillsCatalog,
  normalizeSolanaUsdcPaymentMethod,
  normalizeCryptorefillsPrice,
  createCryptorefillsCatalogClient,
} from '../src/cryptorefills-catalog.mjs';

// Synthetic fixtures composed from fields observed in public GETs on 9 October 2026:
// https://api.cryptorefills.com/v3/payment_vias
// https://api.cryptorefills.com/v2/brands?country_code=US
// https://api.cryptorefills.com/v5/products/country/US?family_name=Steam&coin=USDC&lang=en
// https://api.cryptorefills.com/v5/products/country/US?family_name=airbnb&coin=USDC&lang=en
// https://api.cryptorefills.com/v4/products/price?brand_name=Airbnb&country_code=US&face_value=100&coin=USDC
// Reference: https://www.cryptorefills.com/en/api-docs/developers
// The fixed Steam and flexible Airbnb product IDs are real sample UUIDs. The combined
// group below is synthetic, not a complete response snapshot. Coin amounts/thresholds
// are historical samples, never settlement quotes. Unfiltered US products GET was 400.
const brandId = 'e2ca35ea-1bef-43f2-a12f-12d8ced083c7';
const fixedId = 'e20303ba-f8b0-461d-9c78-44f36cbc40b7';
const rangeId = 'a8884553-a076-4723-81a9-e8d7c4f7e636';
const common = () => ({
  country_code: 'US',
  kind: 'giftcard',
  brand: 'Steam',
  brand_id: brandId,
  family: 'Steam',
  logo_url: 'https://cdn.cryptorefills.com/logos_v2/steam.webp',
  is_out_of_stock: false,
});
const fixed = () => ({
  product_id: fixedId,
  is_dynamic: false,
  denomination: '10 USD',
  coin: 'USDC',
  coin_amount: '11.26',
  payment_method: 'USDC-MATIC',
  face_value: { currency_code: 'USD', amount: { type: 'fixed', price: '10' } },
});
const range = () => ({
  product_id: rangeId,
  is_dynamic: true,
  coin: 'USDC',
  payment_method: 'USDC-MATIC',
  range: { min: 50, max: 500, currency: 'USD', step_size: 1, default: '500.0' },
  face_value: { currency_code: 'USD', amount: { type: 'range', min: '50.00', max: '500.00' } },
});
const products = () => [{ ...common(), products: [fixed(), range()] }];
const methods = () => [
  {
    name: 'USER_WALLET',
    available: true,
    currencies: [
      {
        name: 'USDC',
        is_suspended: false,
        networks: [
          {
            name: 'Solana',
            threshold: '0.562099175481640',
            smart_contract_engine: 'SVM',
            base_token: 'SOL',
            smart_contract: {
              engine: 'SVM',
              address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              decimals: 6,
              symbol: 'USDC',
            },
          },
        ],
      },
    ],
  },
];
const price = () => ({
  product_id: rangeId,
  coin: 'USDC',
  coin_amount: '101.48',
  payment_method: 'USDC-MATIC',
});
const response = (body, options) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    ...options,
  });

test('preserves provider UUIDs and exact fixed/range denominations without settlement prices', () => {
  const records = normalizeCryptorefillsCatalog(products(), 'US');
  assert.equal(records.length, 2);
  assert.equal(records[0].id, `cryptorefills:US:${fixedId}`);
  assert.equal(records[0].providerProductId, fixedId);
  assert.equal(records[0].providerBrandId, brandId);
  assert.equal(records[0].providerDenomination, '10 USD');
  assert.equal(records[0].faceValue, '10');
  assert.equal(records[0].denominationMode, 'FIXED');
  assert.equal(records[1].providerDenomination, 'range');
  assert.equal(records[1].denominationMode, 'FLEXIBLE');
  assert.deepEqual(records[1].range, { min: '50', max: '500', step: '1' });
  assert.ok(records.every((record) => !('voucherId' in record) && !('coinAmount' in record)));
  const raw = products();
  raw[0].is_out_of_stock = true;
  assert.equal(normalizeCryptorefillsCatalog(raw, 'US')[0].available, false);
});

test('filters other product kinds and rejects country, ID, range and duplicate conflicts', () => {
  assert.deepEqual(normalizeCryptorefillsCatalog([{ ...common(), kind: 'esim' }], 'US'), []);
  const cases = [
    (raw) => (raw[0].country_code = 'CA'),
    (raw) => (raw[0].products[0].product_id = '123'),
    (raw) => (raw[0].products[1].range.min = 51),
    (raw) => (raw[0].products[1].range.max = 1),
    (raw) => (raw[0].products[0].face_value.amount.price = 'NaN'),
    (raw) => (raw[0].logo_url = 'https://untrusted.example/logo.png'),
    (raw) => raw[0].products.push({ ...fixed(), denomination: '20 USD' }),
  ];
  for (const change of cases) {
    const raw = products();
    change(raw);
    assert.throws(() => normalizeCryptorefillsCatalog(raw, 'US'));
  }
  const duplicated = products();
  duplicated[0].products.push(fixed());
  assert.equal(normalizeCryptorefillsCatalog(duplicated, 'US').length, 2);
});

test('normalizes every gift-card group without assuming digital product_type', () => {
  const raw = products();
  raw[0].products = [fixed()];
  raw.push({
    ...common(),
    brand_id: 'a0000000-0000-4000-8000-000000000000',
    brand: 'Airbnb',
    family: 'airbnb',
    product_type: 'physical',
    products: [range()],
  });
  raw.push({ ...common(), kind: 'esim', products: null });
  const records = normalizeCryptorefillsCatalog(raw, 'US');
  assert.deepEqual(
    records.map((record) => record.providerProductId),
    [fixedId, rangeId],
  );
  assert.equal(records[1].brandName, 'Airbnb');
  assert.equal(records[1].denominationMode, 'FLEXIBLE');
});

test('brand catalog uses exact API brand IDs/names and enforces the requested country', () => {
  const raw = { country_code: 'US', all_brands: [common(), { ...common(), kind: 'esim' }] };
  const records = normalizeCryptorefillsBrands(raw, 'US');
  assert.equal(records.length, 1);
  assert.equal(records[0].brandName, 'Steam');
  assert.equal(records[0].providerBrandId, brandId);
  assert.throws(() => normalizeCryptorefillsBrands(raw, 'CA'), /catalog/);
});

test('Solana availability binds the exact native USDC mint, decimals and network', () => {
  const supported = normalizeSolanaUsdcPaymentMethod(methods());
  assert.equal(supported.paymentVia, 'USER_WALLET');
  assert.equal(supported.network, 'Solana');
  assert.equal(supported.decimals, 6);
  assert.equal(supported.minimumCoinAmount, '0.56209917548164');
  const cases = [
    (raw) => (raw[0].available = false),
    (raw) => (raw[0].currencies[0].is_suspended = true),
    (raw) => (raw[0].currencies[0].networks[0].smart_contract.decimals = 18),
    (raw) => (raw[0].currencies[0].networks[0].smart_contract.address = 'wrong'),
    (raw) => (raw[0].currencies[0].networks[0].name = 'Base'),
    (raw) => raw.push(structuredClone(raw[0])),
  ];
  for (const change of cases) {
    const raw = methods();
    change(raw);
    assert.throws(() => normalizeSolanaUsdcPaymentMethod(raw));
  }
});

test('currency prices stay explicitly unverified for Solana and bind the selected product', () => {
  assert.deepEqual(normalizeCryptorefillsPrice(price(), rangeId), {
    provider: 'cryptorefills',
    providerProductId: rangeId,
    coin: 'USDC',
    coinAmount: '101.48',
    paymentMethod: 'USDC-MATIC',
    networkVerified: false,
  });
  assert.throws(() => normalizeCryptorefillsPrice(price(), fixedId), /mismatch/);
  assert.throws(
    () => normalizeCryptorefillsPrice({ ...price(), coin: 'USDT' }, rangeId),
    /mismatch/,
  );
});

test('public GET client serializes requests, spaces them, and sends no customer/key data', async () => {
  let clock = 0;
  const waits = [],
    requests = [];
  const client = createCryptorefillsCatalogClient(
    { applicationId: 'public-referral' },
    {
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      fetcher: async (url, init) => {
        requests.push({ url: new URL(url), init, at: clock });
        if (url.includes('payment_vias')) return response(methods());
        if (url.includes('/v2/brands'))
          return response({ country_code: 'US', all_brands: [common()] });
        if (url.includes('/v4/products/price')) return response(price());
        return response(products());
      },
    },
  );
  await Promise.all([
    client.getSolanaUsdc(),
    client.getBrands('US'),
    client.getProducts({ countryCode: 'US', familyName: 'Steam & friends' }),
    client.getPrice({
      countryCode: 'US',
      brandName: 'Airbnb',
      faceValue: '100',
      providerProductId: rangeId,
    }),
  ]);
  assert.deepEqual(
    requests.map((request) => request.at),
    [0, 1000, 2000, 3000],
  );
  assert.deepEqual(waits, [1000, 1000, 1000]);
  for (const { url, init } of requests) {
    assert.equal(url.origin, 'https://api.cryptorefills.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined);
    assert.equal(init.headers['X-Cr-Application'], 'public-referral');
    assert.equal(init.headers['X-CR-Partner-Key'], undefined);
    assert.equal(init.headers['X-Forwarded-For'], undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(requests[2].url.searchParams.get('family_name'), 'Steam & friends');
  assert.equal(requests[3].url.searchParams.get('coin'), 'USDC');
  assert.equal(requests[3].url.searchParams.has('network'), false);
  await assert.rejects(client.getProducts({ countryCode: 'US' }), /filter is required/);
  await assert.rejects(
    client.getPrice({
      countryCode: 'US',
      brandName: 'Airbnb',
      faceValue: '100',
      providerProductId: rangeId,
      network: 'Solana',
    }),
    /Unsupported/,
  );
  assert.equal(requests.length, 4);
  assert.throws(() => createCryptorefillsCatalogClient({ key: 'not-accepted' }), /Unsupported/);
});

test('HTTP failures, oversized/non-JSON responses fail closed without poisoning later GETs', async () => {
  let clock = 0,
    count = 0;
  const client = createCryptorefillsCatalogClient(
    {},
    {
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      fetcher: async () =>
        ++count === 1
          ? response({ private: 'never echoed' }, { status: 429 })
          : response(methods()),
    },
  );
  await assert.rejects(
    client.getSolanaUsdc(),
    (error) => /429/.test(error.message) && !error.message.includes('private'),
  );
  assert.equal((await client.getSolanaUsdc()).network, 'Solana');
  const oversized = createCryptorefillsCatalogClient(
    {},
    { maxResponseBytes: 4, fetcher: async () => response(methods()) },
  );
  await assert.rejects(oversized.getSolanaUsdc(), /too large/);
  const html = createCryptorefillsCatalogClient(
    {},
    {
      fetcher: async () =>
        new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    },
  );
  await assert.rejects(html.getSolanaUsdc(), /not JSON/);
});

test('slow GETs receive an abort signal and do not poison subsequent requests', async () => {
  let clock = 0;
  let count = 0;
  const client = createCryptorefillsCatalogClient(
    {},
    {
      timeoutMs: 5,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      fetcher: async (_url, { signal }) => {
        if (++count > 1) return response(methods());
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
  );
  await assert.rejects(client.getSolanaUsdc(), { name: 'AbortError' });
  assert.equal((await client.getSolanaUsdc()).network, 'Solana');
});
