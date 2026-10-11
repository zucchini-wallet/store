import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { validateCatalogPublication } from '../src/catalog.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';

export async function publishCatalog({
  origin,
  secretsFile,
  catalogFile,
  previewOnly = false,
  provider,
  fetcher = fetch,
  now = Date.now(),
}) {
  if (!origin || !secretsFile || !catalogFile)
    throw Error(
      'Usage: catalog-publish <store-origin> <private-runtime-json> <catalog-json> [--preview]',
    );
  const url = new URL(origin);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname))
  )
    throw Error('Use the store HTTPS origin.');
  if ((await stat(catalogFile)).size > 64 * 1024 * 1024) throw Error('Catalog input is too large');
  const catalog = validateCatalogPublication(JSON.parse(await readFile(catalogFile, 'utf8')), {
    provider,
    previewOnly,
    now,
  });
  const version = randomUUID();
  const metadata = {
    version,
    fetchedAt: catalog.fetchedAt,
    provider: catalog.provider,
    ...(catalog.provider === 'cryptorefills'
      ? {
          previewOnly: true,
          directPrice: catalog.directPrice,
          ...(catalog.selectionScope ? { selectionScope: catalog.selectionScope } : {}),
        }
      : {}),
  };
  // Build all bounded chunks before transmitting any portion of the candidate version.
  const payloads = [];
  let chunk = [];
  const bodyFor = (records) => JSON.stringify({ ...metadata, records });
  for (const record of catalog.vouchers) {
    const candidate = [...chunk, record];
    if (candidate.length > 200 || Buffer.byteLength(bodyFor(candidate)) > 256000) {
      if (!chunk.length) throw Error('Catalog record exceeds the publication limit');
      payloads.push(bodyFor(chunk));
      chunk = [record];
    } else chunk = candidate;
    if (Buffer.byteLength(bodyFor(chunk)) > 256000)
      throw Error('Catalog record exceeds the publication limit');
  }
  if (chunk.length) payloads.push(bodyFor(chunk));
  payloads.push(JSON.stringify({ ...metadata, publish: true, count: catalog.vouchers.length }));
  if ((await stat(secretsFile)).size > 65536) throw Error('Runtime secret input is too large');
  const secrets = JSON.parse(await readFile(secretsFile, 'utf8'));
  if (
    typeof secrets.ADMIN_TOKEN !== 'string' ||
    secrets.ADMIN_TOKEN.length < 32 ||
    secrets.ADMIN_TOKEN.length > 1000 ||
    /[\r\n]/.test(secrets.ADMIN_TOKEN)
  )
    throw Error('A valid private administration token is required');
  for (const body of payloads) {
    const response = await fetcher(url.origin + '/internal/catalog', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secrets.ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    await response.body?.cancel();
    if (!response.ok)
      throw Error(`Catalog publication failed (${response.status}); previous catalog retained.`);
  }
  return {
    count: catalog.vouchers.length,
    provider: catalog.provider,
    version,
    previewOnly: catalog.provider === 'cryptorefills',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [origin, secretsFile, catalogFile, ...flags] = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--preview') || flags.length > 1)
    throw Error('Unsupported catalog publication argument');
  const result = await publishCatalog({
    origin,
    secretsFile,
    catalogFile,
    previewOnly: flags.includes('--preview'),
    provider: process.env.GIFT_CARD_PROVIDER,
  });
  console.log(
    `Published ${result.count} unique ${result.provider} gift cards.${result.previewOnly ? ' Preview only; Solana pricing and identity requirements remain unverified.' : ' Provider prices remain on the backend.'}`,
  );
}
