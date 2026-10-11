import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createZucchiniClient } from '@zucchinifi/dapp-sdk/zcash';

// Execute the real page handlers against an isolated DOM and the installed SDK.
// Every API/provider response is synthetic: no browser, wallet, signing or network IO.
const firstId = '00000000-0000-4000-8000-000000000001';
const otherId = '11111111-0000-4000-8000-000000000002';
const firstToken = 'A'.repeat(43);
const otherToken = 'B'.repeat(43);
const txid = 'a'.repeat(64);
const addresses = {
  unified: 'u1fixture',
  orchard: 'u1fixture',
  sapling: 'zs1fixture',
  transparent: 't1fixture',
};
const product = {
  id: 'fixture-card',
  name: 'Fixture card',
  brandName: 'Fixture brand',
  countryCode: 'US',
  currency: 'USD',
  denominationMode: 'FIXED',
  denominations: ['10.00'],
  minAmount: '10.00',
  maxAmount: '10.00',
  iconUrl: 'https://cdn.cryptorefills.com/fixture.png',
};
const order = (overrides = {}) => ({
  id: firstId,
  giftCardProvider: 'cryptorefills',
  fundingMode: 'direct_swap',
  network: 'mainnet',
  state: 'quoted',
  directState: 'draft',
  brand: 'Fixture brand',
  country: 'US',
  faceAmount: '10.00',
  currency: 'USD',
  totalUsd: '10.00',
  maxInputZatoshis: '13000000',
  quoteExpiresAt: Math.floor(Date.now() / 1000) + 600,
  expiresAt: Math.floor(Date.now() / 1000) + 500,
  ...overrides,
});
const paymentOrder = (original, overrides = {}) => ({
  ...original,
  state: 'payment_pending',
  directState: 'payment_requested',
  amountZatoshis: '12345678',
  paymentUri: 'zcash:t1fixture?amount=0.12345678',
  paymentApprovalExpiresAt: Math.floor(Date.now() / 1000) + 120,
  ...overrides,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function eventually(condition) {
  for (let i = 0; i < 30 && !condition(); i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), 'Expected page operation did not reach its synthetic boundary');
}
class Node {
  children = [];
  options = [];
  dataset = {};
  style = {};
  value = '';
  hidden = true;
  disabled = false;
  checked = false;
  open = false;
  textContent = '';
  classList = { toggle() {} };
  constructor(id = '') {
    this.id = id;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  add(option) {
    this.options.push(option);
  }
  setAttribute() {}
  addEventListener() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
async function page(options = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Node(id));
    return nodes.get(id);
  };
  const storage = options.storage ?? new Map();
  const apiCalls = [],
    walletCalls = [],
    connections = [],
    intervals = [];
  const orders = new Map(options.orders ?? []);
  const listeners = new Map();
  let networkReads = 0;
  const emit = (event) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener();
  };
  const provider = {
    async connect(permissions) {
      connections.push([...permissions]);
      return { connected: true, approvedPermissions: permissions, accounts: [] };
    },
    async disconnect() {
      emit('disconnect');
    },
    async request(request) {
      walletCalls.push(structuredClone(request));
      if (request.method === 'getNetwork') {
        networkReads++;
        await options.onNetwork?.(networkReads, emit);
        return { network: 'main' };
      }
      if (request.method === 'getAddresses') return options.onAddresses?.() ?? addresses;
      if (request.method === 'zcash_requestPayment') return options.onPayment?.(request) ?? txid;
      assert.fail(`Unexpected provider method ${request.method}`);
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
  const response = (value) => new Response(JSON.stringify(value));
  const context = createContext({
    document: {
      getElementById: node,
      createElement: () => new Node(),
      querySelectorAll: (selector) =>
        selector === 'dialog[open]' ? [...nodes.values()].filter((element) => element.open) : [],
      addEventListener() {},
    },
    Image: Node,
    Option: class extends Node {
      constructor(label, value) {
        super();
        this.textContent = label;
        this.value = value;
      }
    },
    createZucchiniClient,
    discoverZucchiniProvider: () => provider,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    location: { origin: 'https://store.example', pathname: '/', hash: options.hash ?? '' },
    history: { replaceState() {} },
    navigator: { clipboard: { async writeText() {} } },
    AbortSignal,
    URLSearchParams,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval() {},
    async fetch(path, init) {
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      const call = { path, method: init.method, headers: init.headers, body };
      apiCalls.push(call);
      if (path === '/api/config')
        return response({
          network: 'mainnet',
          fundingMode: 'direct_swap',
          giftCardProvider: 'cryptorefills',
          checkoutReady: true,
          catalogPreview: false,
          emailAvailable: false,
        });
      if (path.startsWith('/api/catalog?'))
        return response({ countries: ['US'], items: [product], total: 1 });
      if (path === '/api/orders') {
        const created = order();
        orders.set(created.id, created);
        return response({ order: created, token: firstToken });
      }
      const match = /^\/api\/orders\/([^/]+)(?:\/(pay|submitted|cancel))?$/.exec(path);
      assert.ok(match, `Unexpected synthetic route ${path}`);
      const original = orders.get(match[1]);
      assert.ok(original, 'Unknown synthetic order');
      if (options.onApi) {
        const value = await options.onApi(call, original);
        if (value !== undefined) {
          if (value.order) orders.set(value.order.id, value.order);
          return response(value);
        }
      }
      let updated = original;
      if (match[2] === 'pay')
        updated =
          original.directState === 'draft'
            ? { ...original, directState: 'quote_ready', amountZatoshis: '12345678' }
            : paymentOrder(original);
      if (match[2] === 'cancel')
        updated = { ...original, state: 'cancelled', directState: 'cancelled' };
      orders.set(updated.id, updated);
      return response({ order: updated });
    },
  });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const importPattern = /^import\s+\{[^}]+\}\s+from\s+['"]@zucchinifi\/dapp-sdk\/zcash['"];?\s*/;
  assert.match(source, importPattern);
  await runInContext(`(async () => {${source.replace(importPattern, '')}\n})()`, context);
  assert.equal(node('catalog-error').hidden, true, node('catalog-error').textContent);
  const payments = () => walletCalls.filter((call) => call.method === 'zcash_requestPayment');
  const posts = (suffix) =>
    apiCalls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix));
  return {
    node,
    storage,
    apiCalls,
    walletCalls,
    connections,
    orders,
    emit,
    payments,
    posts,
    connect: () => node('connect-wallet').onclick(),
    checkout: () => node('checkout-action').onclick(),
    refresh: async () => {
      for (const callback of intervals) await callback();
    },
    choose: () => node('products').children[0].onclick(),
    async quote(cap = '0.13') {
      node('fixed-amount').value = '10.00';
      node('max-zec').value = cap;
      node('direct-refund-address').value = addresses.transparent;
      node('email').value = 'fixture@example.com';
      node('provider-terms').checked = node('provider-privacy').checked = true;
      await node('quote-form').onsubmit({ preventDefault() {} });
    },
    async openSaved(id) {
      node('checkout-dialog').close();
      node('orders').onclick();
      const button = node('info-body').children.find((child) =>
        child.textContent.endsWith(id.slice(0, 8)),
      );
      assert.ok(button, 'Synthetic saved order link missing');
      await button.onclick();
    },
  };
}
const saved = (id, token) => ({ id, token, brand: 'Fixture brand' });
const restore = (o, token = firstToken, extra = []) => ({
  orders: [[o.id, o], ...extra],
  hash: `#order=${o.id}&key=${token}`,
  storage: new Map([
    [
      'zucchini-store-orders',
      JSON.stringify([saved(o.id, token), ...extra.map(([id]) => saved(id, otherToken))]),
    ],
  ]),
});

test('ZEC caps preserve atomic precision and invalid caps stop before order creation', async () => {
  const p = await page();
  p.choose();
  for (const invalid of ['0', '-1', '1e-8', 'NaN', '00.1', '0.000000001', '21000000.00000001']) {
    await p.quote(invalid);
    assert.equal(p.posts('/api/orders').length, 0, invalid);
    assert.equal(p.node('quote-error').hidden, false, invalid);
  }
  await p.quote('0.00000001');
  assert.equal(p.posts('/api/orders')[0].body.maxInputZatoshis, '1');
  await p.quote('21000000');
  assert.equal(p.posts('/api/orders')[1].body.maxInputZatoshis, '2100000000000000');
  assert.equal(p.payments().length, 0);
  assert.equal(p.connections.length, 0);
});

test('address access needs explicit consent and a click; stale address responses cannot fill a new session', async () => {
  const valid = await page();
  valid.choose();
  await valid.connect();
  assert.equal(
    valid.walletCalls.some((call) => call.method === 'getAddresses'),
    false,
  );
  await valid.node('use-wallet-refund').onclick();
  assert.equal(valid.node('direct-refund-address').value, addresses.transparent);
  assert.equal(valid.payments().length, 0);
  const waiting = deferred();
  const p = await page({ onAddresses: () => waiting.promise });
  p.choose();
  await p.node('use-wallet-refund').onclick();
  assert.equal(p.walletCalls.length, 0);
  await p.connect();
  assert.deepEqual(p.connections, [['send_transaction', 'view_addresses']]);
  assert.equal(
    p.walletCalls.some((call) => call.method === 'getAddresses'),
    false,
  );
  const read = p.node('use-wallet-refund').onclick();
  await eventually(() => p.walletCalls.some((call) => call.method === 'getAddresses'));
  p.emit('accountsChanged');
  waiting.resolve(addresses);
  await read;
  assert.equal(p.node('direct-refund-address').value, '');
  assert.match(p.node('quote-error').textContent, /connection changed/i);
  assert.equal(p.payments().length, 0);
});

test('connecting, requesting the exact quote and confirming payment are separate actions', async () => {
  const p = await page();
  p.choose();
  await p.quote();
  await p.connect();
  assert.equal(p.posts('/pay').length, 0);
  assert.equal(p.payments().length, 0);
  await p.checkout();
  assert.equal(p.posts('/pay').length, 1);
  assert.equal(p.payments().length, 0);
  assert.match(p.node('zec-total').textContent, /0\.12345678 ZEC/);
  await p.checkout();
  assert.equal(p.posts('/pay').length, 2);
  assert.equal(p.payments().length, 1);
  assert.equal(p.payments()[0].params.uri, 'zcash:t1fixture?amount=0.12345678');
  assert.equal(p.payments()[0].params.expiresAt, p.orders.get(firstId).paymentApprovalExpiresAt);
  assert.equal(p.posts('/submitted')[0].body.txid, txid);
});

test('old wallet deadline rejection is never retried or replayed when the saved order is restored', async () => {
  const initial = order({ directState: 'quote_ready', amountZatoshis: '12345678' });
  const p = await page({
    ...restore(initial),
    onPayment: async () => {
      throw Object.assign(Error('Unsupported payment deadline'), { code: -32602 });
    },
  });
  await p.connect();
  await p.checkout();
  assert.equal(p.payments().length, 1);
  assert.ok(p.payments()[0].params.expiresAt);
  assert.match(p.node('checkout-error').textContent, /Unsupported payment deadline/);
  await p.checkout();
  await p.refresh();
  assert.equal(p.payments().length, 1);
  assert.equal(p.posts('/submitted').length, 0);
  const restarted = await page({ ...restore(p.orders.get(firstId)), storage: p.storage });
  await restarted.refresh();
  await restarted.checkout();
  assert.equal(restarted.payments().length, 0);
  assert.equal(restarted.connections.length, 0);
  assert.equal(restarted.posts('/pay').length, 0);
  assert.equal(restarted.node('checkout-action').hidden, true);
});

test('direct payment cannot omit its approval deadline or pass an expired deadline to the provider', async () => {
  for (const expiresAt of [undefined, Math.floor(Date.now() / 1000) - 1, 1.5, '1800000120']) {
    const initial = order({ directState: 'quote_ready', amountZatoshis: '12345678' });
    const p = await page({
      ...restore(initial),
      onApi: (call, original) =>
        call.path.endsWith('/pay')
          ? { order: paymentOrder(original, { paymentApprovalExpiresAt: expiresAt }) }
          : undefined,
    });
    await p.connect();
    await p.checkout();
    assert.equal(p.payments().length, 0, `Unexpected wallet request for deadline ${expiresAt}`);
    assert.equal(p.node('checkout-error').hidden, false);
  }
});

test('account revocation during the network check prevents a payment API action', async () => {
  const initial = order({ directState: 'quote_ready', amountZatoshis: '12345678' });
  const p = await page({
    ...restore(initial),
    onNetwork: (count, emit) => {
      if (count === 2) emit('accountsChanged');
    },
  });
  await p.connect();
  await p.checkout();
  assert.equal(p.posts('/pay').length, 0);
  assert.equal(p.payments().length, 0);
  assert.match(p.node('checkout-error').textContent, /connection changed/i);
});

test('changing the visible order while payment preparation is pending cannot prompt a stale payment', async () => {
  const initial = order({ directState: 'quote_ready', amountZatoshis: '12345678' });
  const other = order({
    id: otherId,
    directState: 'quote_ready',
    amountZatoshis: '12345678',
    brand: 'Other brand',
  });
  const waiting = deferred();
  const p = await page({
    ...restore(initial, firstToken, [[otherId, other]]),
    onApi: (call) => (call.path === `/api/orders/${firstId}/pay` ? waiting.promise : undefined),
  });
  await p.connect();
  const approval = p.checkout();
  await eventually(() => p.posts('/pay').length === 1);
  await p.openSaved(otherId);
  waiting.resolve({ order: paymentOrder(initial) });
  await approval;
  assert.equal(p.payments().length, 0);
  assert.equal(p.posts('/submitted').length, 0);
  assert.equal(p.node('order-reference').textContent, `Order ${otherId}`);
});

test('a completed wallet request submits only to its original order even after the visible order changes', async () => {
  const initial = order({ directState: 'quote_ready', amountZatoshis: '12345678' });
  const other = paymentOrder(order({ id: otherId, brand: 'Other brand' }));
  const waiting = deferred();
  const p = await page({
    ...restore(initial, firstToken, [[otherId, other]]),
    onPayment: () => waiting.promise,
  });
  await p.connect();
  const approval = p.checkout();
  await eventually(() => p.payments().length === 1);
  await p.openSaved(otherId);
  waiting.resolve(txid);
  await approval;
  assert.equal(p.payments().length, 1);
  assert.equal(p.posts('/submitted').length, 1);
  assert.equal(p.posts('/submitted')[0].path, `/api/orders/${firstId}/submitted`);
  assert.equal(p.posts('/submitted')[0].headers.Authorization, `Bearer ${firstToken}`);
  assert.equal(p.node('order-reference').textContent, `Order ${otherId}`);
});

test('the invoice preparation action cannot pay even if another tab already advanced the same order', async () => {
  const initial = order();
  const p = await page({
    ...restore(initial),
    onApi: (call, original) =>
      call.path.endsWith('/pay') ? { order: paymentOrder(original) } : undefined,
  });
  await p.connect();
  await p.checkout();
  assert.equal(p.posts('/pay').length, 1);
  assert.equal(p.payments().length, 0, 'A draft action did not review an exact ZEC quote');
  assert.equal(p.posts('/submitted').length, 0);
});

test('a changed exact amount cannot replace the amount reviewed before the wallet request', async () => {
  const initial = order({ directState: 'quote_ready', amountZatoshis: '12345678' });
  const p = await page({
    ...restore(initial),
    onApi: (call, original) =>
      call.path.endsWith('/pay')
        ? {
            order: paymentOrder(original, {
              amountZatoshis: '12345679',
              paymentUri: 'zcash:t1fixture?amount=0.12345679',
            }),
          }
        : undefined,
  });
  await p.connect();
  await p.checkout();
  assert.equal(p.payments().length, 0);
  assert.equal(p.posts('/submitted').length, 0);
});

test('repeated clicks during wallet review create one payment request and one submission', async () => {
  const initial = order({ directState: 'quote_ready', amountZatoshis: '12345678' });
  const waiting = deferred();
  const p = await page({ ...restore(initial), onPayment: () => waiting.promise });
  await p.connect();
  const first = p.checkout();
  await eventually(() => p.payments().length === 1);
  await p.checkout();
  await p.refresh();
  assert.equal(p.posts('/pay').length, 1);
  assert.equal(p.payments().length, 1);
  waiting.resolve(txid);
  await first;
  await p.checkout();
  assert.equal(p.payments().length, 1);
  assert.equal(p.posts('/submitted').length, 1);
});
