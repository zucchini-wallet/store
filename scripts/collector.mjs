import { paymentMemo } from '../src/payment-memo.mjs';
import { createReceiptScanner } from '@zucchinifi/zcash-scanner';
import { readFile, writeFile, rename, mkdir, open, unlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { reconcileBatch, snapshotFor } from '../src/collector-state.mjs';
const env = process.env,
  network = env.NETWORK ?? 'mainnet',
  birthday = Number(env.SCANNER_BIRTHDAY),
  recipient = env.MERCHANT_RECEIVER,
  token = env.ADMIN_TOKEN;
if (!Number.isSafeInteger(birthday) || birthday < 1 || !recipient || token?.length < 32)
  throw Error('Configure scanner birthday, recipient and admin token first.');
const keyPath = resolve(env.VIEWING_KEY_FILE),
  keyStat = await stat(keyPath);
if (keyStat.mode & 0o077) throw Error('Viewing key must have owner-only permissions (chmod 600).');
const identity = createHash('sha256')
  .update(await readFile(keyPath))
  .update(JSON.stringify({ network, birthday, recipient, endpoint: env.SCANNER_ENDPOINT }))
  .digest('hex');
const scanner = createReceiptScanner({
  binary: resolve(env.SCANNER_BINARY),
  viewingKeyFile: keyPath,
  endpoint: env.SCANNER_ENDPOINT,
  network,
});
const file = resolve(env.DATA_DIR ?? 'data', 'scanner-state.json');
await mkdir(dirname(file), { recursive: true, mode: 0o700 });
const lock = await open(file + '.lock', 'wx', 0o600);
await lock.writeFile(String(process.pid));
async function api(path, value) {
  const r = await fetch(
    (env.SCANNER_STORE_ORIGIN ?? `http://127.0.0.1:${env.PORT ?? 4390}`) + path,
    {
      method: value ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(value ? { 'Content-Type': 'application/json' } : {}),
      },
      body: value ? JSON.stringify(value) : undefined,
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    },
  );
  if (!r.ok) throw Error('Store scanner update unavailable');
  return r.json();
}
let stop = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stop = true;
  });
try {
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    state = {
      identity,
      network,
      birthday,
      scannedHeight: birthday - 1,
      blocks: [],
      seen: {},
      sequence: 0,
      caughtUp: false,
    };
  }
  if (state.identity !== identity)
    throw Error('Scanner wallet identity changed. Start a separate state directory.');
  do {
    let delay = 15000;
    try {
      const { orders } = await api('/internal/orders');
      const wanted = new Set(orders.map(paymentMemo));
      const batch = await scanner.scan({
        from: Math.max(birthday, state.scannedHeight - (state.caughtUp ? 20 : 0) + 1),
        limit: 100,
        recipients: [recipient],
      });
      for (const b of batch.blocks) b.receipts = b.receipts.filter((r) => wanted.has(r.memo));
      state = reconcileBatch(state, batch, birthday, Math.floor(Date.now() / 1000));
      state.sequence++;
      await writeFile(file + '.tmp', JSON.stringify(state), { mode: 0o600, flush: true });
      await rename(file + '.tmp', file);
      for (const order of orders) {
        if (order.network !== network || order.recipient !== recipient)
          throw Error('Scanner order identity mismatch');
        await api('/internal/receipt', { orderId: order.id, snapshot: snapshotFor(state, order) });
      }
      if (state.caughtUp) await api('/internal/heartbeat', { network, recipient, caughtUp: true });
      else delay = 1000;
      console.log(
        `Scanner ${state.caughtUp ? 'caught up' : 'catching up'}; ${orders.length} orders checked.`,
      );
    } catch {
      console.error(
        'Receipt verification temporarily unavailable; checkout will pause automatically.',
      );
      delay = 30000;
      if (process.argv.includes('--once')) process.exitCode = 1;
    }
    if (!stop && !process.argv.includes('--once')) await new Promise((r) => setTimeout(r, delay));
  } while (!stop && !process.argv.includes('--once'));
} finally {
  await lock.close();
  await unlink(file + '.lock');
}
