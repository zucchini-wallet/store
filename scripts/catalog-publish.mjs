import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cleanCatalog } from '../src/catalog.mjs';
const [origin, secretsFile, catalogFile] = process.argv.slice(2);
if (!origin || !secretsFile || !catalogFile)
  throw Error('Usage: catalog-publish <store-origin> <private-runtime-json> <catalog-json>');
const url = new URL(origin);
if (
  !['https:', 'http:'].includes(url.protocol) ||
  (url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname))
)
  throw Error('Use the store HTTPS origin.');
const secrets = JSON.parse(await readFile(secretsFile, 'utf8')),
  catalog = JSON.parse(await readFile(catalogFile, 'utf8')),
  records = cleanCatalog(catalog.vouchers),
  version = randomUUID();
async function send(value) {
  const response = await fetch(url.origin + '/internal/catalog', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secrets.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...value, version, fetchedAt: catalog.fetchedAt }),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok)
    throw Error(`Catalog publication failed (${response.status}); previous catalog retained.`);
}
for (let offset = 0; offset < records.length; offset += 200)
  await send({ records: records.slice(offset, offset + 200) });
await send({ publish: true, count: records.length });
console.log(
  `Published ${records.length} unique gift cards. Provider pricing and credentials stay on the backend.`,
);
