import { credentials } from '../src/credentials.mjs';
import { cleanCatalog } from '../src/catalog.mjs';
import { createProvider } from '../src/provider.mjs';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const target = resolve(process.env.DATA_DIR ?? 'data', 'catalog.json');
await mkdir(resolve(process.env.DATA_DIR ?? 'data'), { recursive: true, mode: 0o700 });
if (process.argv.includes('--import')) {
  const source = process.argv[process.argv.indexOf('--import') + 1];
  const catalog = JSON.parse(await readFile(source, 'utf8'));
  if (!Array.isArray(catalog.vouchers) || catalog.vouchers.length > 50000)
    throw Error('Invalid catalog');
  catalog.vouchers = cleanCatalog(catalog.vouchers);
  await writeFile(target, JSON.stringify(catalog), { mode: 0o600 });
  console.log(`Imported ${catalog.vouchers.length} gift cards.`);
} else {
  const provider = createProvider(await credentials(process.env.OFIAT_ENV_FILE)),
    vouchers = [];
  for (let offset = 0; offset < 50000; offset += 200) {
    const result = await provider.request('/vouchers?limit=200&offset=' + offset);
    if (result.settlementCurrency !== 'USD' || !Array.isArray(result.vouchers))
      throw Error('Unexpected provider catalog');
    vouchers.push(...result.vouchers);
    if (result.vouchers.length < 200) break;
  }
  if (!vouchers.length || vouchers.length >= 50000) throw Error('Incomplete catalog');
  await writeFile(
    target + '.tmp',
    JSON.stringify({ fetchedAt: new Date().toISOString(), vouchers: cleanCatalog(vouchers) }),
    { mode: 0o600 },
  );
  await rename(target + '.tmp', target);
  console.log(`Cached ${vouchers.length} gift cards. Refresh once daily.`);
}
