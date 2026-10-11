import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanCatalog,
  cleanCatalogDocument,
  catalogRecordKey,
  catalogPage,
  validateCatalogPublication,
} from '../src/catalog.mjs';
import {
  normalizeCryptorefillsCatalog,
  CRYPTOREFILLS_DIRECT_PRICE_POLICY,
} from '../src/cryptorefills-catalog.mjs';
import { validateFace } from '../src/domain.mjs';
import { syncCatalog, cleanCryptorefillsSelections } from '../scripts/catalog-sync.mjs';
import { publishCatalog } from '../scripts/catalog-publish.mjs';
import { refreshSelectedCryptorefillsCatalog } from '../src/catalog-refresh.mjs';

const now = Date.parse('2026-10-11T00:00:00.000Z');
const legacy = () => ({
  voucherId: 42,
  brandName: 'Legacy brand',
  name: 'Legacy brand',
  countryCode: 'US',
  currency: 'USD',
  denominationMode: 'FIXED',
  denominations: [10],
  minAmount: 10,
  maxAmount: 10,
  discount: '1.25',
});
// Synthetic contract fixtures; real public shape is documented in cryptorefills-catalog.test.mjs.
const products = () =>
  normalizeCryptorefillsCatalog(
    [
      {
        kind: 'giftcard',
        country_code: 'US',
        brand_id: '10000000-0000-4000-8000-000000000000',
        brand: 'Airbnb',
        family: 'Airbnb',
        logo_url: 'https://cdn.cryptorefills.com/logos_v2/airbnb.webp',
        is_out_of_stock: false,
        products: [
          {
            product_id: '20000000-0000-4000-8000-000000000000',
            is_dynamic: true,
            coin: 'USDC',
            delivery_type: 'by_email',
            product_type: 'physical',
            range: { min: 50, max: 500, currency: 'USD', step_size: 1 },
            face_value: { currency_code: 'USD', amount: { type: 'range', min: '50', max: '500' } },
          },
        ],
      },
    ],
    'US',
  );
const document = () => ({
  provider: 'cryptorefills',
  fetchedAt: new Date(now).toISOString(),
  vouchers: products(),
  directPrice: { ...CRYPTOREFILLS_DIRECT_PRICE_POLICY },
  selectionScope: 'selected_families',
});
test('daily refresh reads only published families and rejects partial or mismatched replacement', async () => {
  const original = document(),
    calls = [];
  const client = {
    getSolanaUsdc: async () => {
      calls.push('availability');
    },
    getProducts: async (selection) => {
      calls.push(selection);
      return products();
    },
  };
  const refreshed = await refreshSelectedCryptorefillsCatalog(original, {
    client,
    now: now + 86400000,
  });
  assert.equal(refreshed.fetchedAt, '2026-10-12T00:00:00.000Z');
  assert.equal(refreshed.directPrice.networkVerified, false);
  assert.deepEqual(calls, ['availability', { countryCode: 'US', familyName: 'Airbnb' }]);
  client.getProducts = async () => [{ ...products()[0], countryCode: 'CA' }];
  await assert.rejects(
    refreshSelectedCryptorefillsCatalog(original, { client, now }),
    /selected family/,
  );
  client.getProducts = async () => [];
  await assert.rejects(
    refreshSelectedCryptorefillsCatalog(original, { client, now }),
    /complete fresh/,
  );
  assert.equal(original.fetchedAt, new Date(now).toISOString());
  assert.deepEqual(original.vouchers, products());
});
async function files(t, value = document()) {
  const dir = await mkdtemp(join(tmpdir(), 'zucchini-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogFile = join(dir, 'catalog.json'),
    secretsFile = join(dir, 'runtime.json');
  await writeFile(catalogFile, JSON.stringify(value));
  await writeFile(secretsFile, JSON.stringify({ ADMIN_TOKEN: 'a'.repeat(32) }), { mode: 0o600 });
  return { dir, catalogFile, secretsFile };
}

test('legacy integer catalogs and provider-scoped UUID catalogs round-trip without coercion', () => {
  assert.deepEqual(cleanCatalog([legacy()]), [legacy()]);
  assert.equal(catalogRecordKey(legacy()), '0fiat:42');
  const [record] = cleanCatalog(products(), 'cryptorefills');
  assert.equal(catalogRecordKey(record), record.id);
  assert.equal(record.id, `cryptorefills:US:${record.providerProductId}`);
  assert.equal(record.voucherId, undefined);
  assert.deepEqual(record.range, { min: '50', max: '500', step: '1' });
  assert.equal(record.stepAmount, '1');
  assert.equal(record.minAmount, '50');
  assert.deepEqual(cleanCatalog([record], 'cryptorefills'), [record]);
  assert.throws(() => cleanCatalog(products()), /legacy/);
  assert.throws(() => cleanCatalog([legacy()], 'cryptorefills'));
  assert.throws(() => cleanCatalog([{ ...record, voucherId: 42 }], 'cryptorefills'), /Unsupported/);
  assert.throws(
    () => cleanCatalog([{ ...record, coinAmount: '50' }], 'cryptorefills'),
    /Unsupported/,
  );
  assert.throws(
    () => cleanCatalog([{ ...record, minAmount: '1' }], 'cryptorefills'),
    /Conflicting/,
  );
});

test('UUID records require preview eligibility and public catalog fields exclude backend product data', () => {
  for (const field of ['networkVerified', 'identityRequirementsVerified', 'checkoutEligible'])
    assert.throws(
      () => cleanCatalog([{ ...products()[0], [field]: true }], 'cryptorefills'),
      /readiness/,
    );
  const records = cleanCatalog(products(), 'cryptorefills');
  const page = catalogPage(records, { country: 'US', category: 'travel' });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].id, records[0].id);
  assert.equal(page.items[0].voucherId, undefined);
  assert.equal(page.items[0].providerDenomination, undefined);
  assert.equal(page.items[0].providerBrandId, undefined);
  assert.equal(page.items[0].networkVerified, false);
  assert.equal(catalogPage(records, { country: 'US', search: 'other' }).items.length, 0);
});

test('publication rejects stale, mismatched, or network-verified CR catalogs and requires preview', () => {
  const value = document();
  assert.equal(cleanCatalogDocument(value).directPrice.networkVerified, false);
  assert.throws(() => validateCatalogPublication(value, { now }), /preview/);
  assert.equal(
    validateCatalogPublication(value, { now, previewOnly: true }).provider,
    'cryptorefills',
  );
  assert.throws(
    () => validateCatalogPublication(value, { now, previewOnly: true, provider: '0fiat' }),
    /mismatch/,
  );
  assert.throws(
    () =>
      cleanCatalogDocument({
        ...value,
        directPrice: { ...value.directPrice, networkVerified: true },
      }),
    /unverified/,
  );
  assert.throws(() => cleanCatalogDocument({ ...value, payableAmount: '100' }), /metadata/);
  assert.throws(
    () =>
      validateCatalogPublication(
        { ...value, fetchedAt: new Date(now - 48 * 3600000).toISOString() },
        { now, previewOnly: true },
      ),
    /fresh/,
  );
  assert.throws(
    () => validateCatalogPublication({ ...value, vouchers: [] }, { now, previewOnly: true }),
    /complete/,
  );
});

test('CR range amounts honor the provider step with exact decimal arithmetic', () => {
  const [record] = cleanCatalog(products(), 'cryptorefills');
  assert.equal(validateFace(record, '50'), '50.00');
  assert.equal(validateFace(record, '51'), '51.00');
  assert.throws(() => validateFace(record, '50.50'), /provider amount/);
  assert.throws(
    () => validateFace({ ...record, range: { min: '50', max: '500' } }, '50'),
    /provider amount/,
  );
  const fractional = {
    ...record,
    minAmount: '50.05',
    range: { min: '50.05', max: '500', step: '0.1' },
  };
  assert.equal(validateFace(fractional, '50.15'), '50.15');
  assert.throws(() => validateFace(fractional, '50.10'), /provider amount/);
  assert.equal(validateFace({ ...legacy(), denominationMode: 'FLEXIBLE' }, '10'), '10.00');
});

test('selected-family sync writes only normalized CR previews without orders or keys', async (t) => {
  const { dir, catalogFile } = await files(t);
  const selectionFile = join(dir, 'selection.json');
  await writeFile(selectionFile, JSON.stringify([{ countryCode: 'US', familyName: 'airbnb' }]));
  const calls = [];
  const value = await syncCatalog({
    argv: ['--selection', selectionFile],
    env: { GIFT_CARD_PROVIDER: 'cryptorefills', DATA_DIR: dir },
    now: () => new Date(now).toISOString(),
    client: {
      getSolanaUsdc: async () => {
        calls.push('methods');
        return { network: 'Solana' };
      },
      getProducts: async (input) => {
        calls.push(input);
        return products();
      },
    },
  });
  assert.deepEqual(calls, ['methods', { countryCode: 'US', familyName: 'airbnb' }]);
  assert.equal(value.directPrice.networkVerified, false);
  assert.equal(value.selectionScope, 'selected_families');
  assert.deepEqual(JSON.parse(await readFile(catalogFile, 'utf8')), value);
  const prior = await readFile(catalogFile, 'utf8');
  await assert.rejects(
    syncCatalog({
      argv: ['--selection', selectionFile],
      env: { GIFT_CARD_PROVIDER: 'cryptorefills', DATA_DIR: dir },
      client: {
        getSolanaUsdc: async () => ({}),
        getProducts: async () => [{ ...products()[0], familyName: 'wrong' }],
      },
    }),
    /selected/,
  );
  assert.equal(await readFile(catalogFile, 'utf8'), prior);
  assert.throws(
    () =>
      cleanCryptorefillsSelections([
        { countryCode: 'US', familyName: 'airbnb', network: 'Solana' },
      ]),
    /selection/,
  );
});

test('catalog publication carries UUID/preview pricing policy and aborts unsafe input before I/O', async (t) => {
  const f = await files(t),
    requests = [];
  const options = {
    ...f,
    origin: 'https://store.example',
    now,
    fetcher: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response('{}');
    },
  };
  await assert.rejects(publishCatalog(options), /preview/);
  assert.equal(requests.length, 0);
  const result = await publishCatalog({ ...options, previewOnly: true });
  assert.equal(result.previewOnly, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.records[0].voucherId, undefined);
  assert.equal(requests[0].body.records[0].id, products()[0].id);
  for (const { url, init, body } of requests) {
    assert.equal(url, 'https://store.example/internal/catalog');
    assert.equal(init.redirect, 'error');
    assert.equal(body.previewOnly, true);
    assert.equal(body.directPrice.networkVerified, false);
    assert.equal(body.directPrice.source, 'provider_invoice_required');
    assert.equal(body.ADMIN_TOKEN, undefined);
    assert.ok(Buffer.byteLength(init.body) <= 256000);
  }
  assert.equal(requests[1].body.publish, true);
  assert.equal(requests[1].body.count, 1);
  assert.equal(requests[1].body.version, requests[0].body.version);
});
