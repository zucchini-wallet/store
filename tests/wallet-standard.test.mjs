import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWalletRegistry,
  getSolanaWallets,
  getSolanaAccounts,
  selectSolanaAccount,
} from '../public/wallet-standard.js';

const previousWindow = globalThis.window;
const syntheticWindow = new EventTarget();
globalThis.window = syntheticWindow;
after(() => {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});
const chain = 'solana:mainnet';
const feature = 'solana:signAndSendTransaction';
const account = (address, overrides = {}) => ({
  address,
  publicKey: new Uint8Array(32),
  chains: [chain],
  features: [feature],
  ...overrides,
});
const wallet = (overrides = {}) => ({
  version: '1.0.0',
  name: 'Synthetic Solana wallet',
  icon: 'data:image/png;base64,',
  chains: [chain],
  accounts: [],
  features: {
    'standard:connect': {
      version: '1.0.0',
      connect: () => assert.fail('Discovery must not request wallet authorization'),
    },
    [feature]: {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy'],
      signAndSendTransaction: () => assert.fail('Discovery must not sign or send'),
    },
  },
  ...overrides,
});
function register(registeredWallet) {
  let unregister;
  const event = new Event('wallet-standard:register-wallet');
  Object.defineProperty(event, 'detail', {
    value: (api) => {
      unregister = api.register(registeredWallet);
    },
  });
  syntheticWindow.dispatchEvent(event);
  assert.equal(typeof unregister, 'function');
  return unregister;
}

test('discovers wallets loading before and after app readiness, then tracks removal', (t) => {
  const earlyWallet = wallet();
  let removeEarly;
  const ready = ({ detail }) => {
    removeEarly = detail.register(earlyWallet);
  };
  syntheticWindow.addEventListener('wallet-standard:app-ready', ready);
  const registry = getWalletRegistry();
  syntheticWindow.removeEventListener('wallet-standard:app-ready', ready);
  assert.equal(getWalletRegistry(), registry);
  assert.ok(getSolanaWallets().includes(earlyWallet));
  t.after(removeEarly);
  const events = [];
  t.after(registry.on('register', (...wallets) => events.push(['register', ...wallets])));
  t.after(registry.on('unregister', (...wallets) => events.push(['unregister', ...wallets])));
  const lateWallet = wallet();
  const removeLate = register(lateWallet);
  t.after(removeLate);
  assert.ok(getSolanaWallets().includes(lateWallet));
  const removeDuplicate = register(lateWallet);
  removeDuplicate();
  assert.equal(registry.get().filter((entry) => entry === lateWallet).length, 1);
  removeLate();
  assert.ok(!getSolanaWallets().includes(lateWallet));
  assert.deepEqual(events, [
    ['register', lateWallet],
    ['unregister', lateWallet],
  ]);
});

test('requires exact network, callable features, and legacy transaction support', (t) => {
  const supported = wallet();
  const zeroOnly = wallet();
  zeroOnly.features[feature].supportedTransactionVersions = [0];
  const devnetOnly = wallet({ chains: ['solana:devnet'] });
  const noConnect = wallet();
  delete noConnect.features['standard:connect'];
  const unsupportedVersion = wallet();
  unsupportedVersion.features[feature].version = '2.0.0';
  const invalidMethod = wallet();
  invalidMethod.features[feature].signAndSendTransaction = true;
  for (const candidate of [
    supported,
    zeroOnly,
    devnetOnly,
    noConnect,
    unsupportedVersion,
    invalidMethod,
  ])
    t.after(register(candidate));
  assert.deepEqual(getSolanaWallets(), [supported]);
  assert.deepEqual(getSolanaWallets({ transactionVersion: 0 }), [zeroOnly]);
  assert.deepEqual(getSolanaWallets({ chain: 'solana:devnet' }), [devnetOnly]);
});

test('selects the exact authorized account only when its own capabilities match', (t) => {
  const exact = account('merchant');
  const registeredWallet = wallet({
    accounts: [
      account('first'),
      account('merchant', { chains: ['solana:devnet'] }),
      account('merchant', { features: ['solana:signTransaction'] }),
      exact,
    ],
  });
  t.after(register(registeredWallet));
  assert.deepEqual(getSolanaAccounts(registeredWallet), [registeredWallet.accounts[0], exact]);
  assert.equal(selectSolanaAccount(registeredWallet, 'merchant'), exact);
  assert.throws(() => selectSolanaAccount(registeredWallet, 'missing'), /exact authorized/);
  assert.throws(() => selectSolanaAccount(registeredWallet, ''), /exact Solana account/);
  assert.deepEqual(getSolanaAccounts(wallet({ accounts: [exact] })), []);
  assert.throws(
    () => selectSolanaAccount(wallet({ accounts: [exact] }), 'merchant'),
    /exact authorized/,
  );
});

test('account revocation and wallet removal invalidate selection without reconnecting', (t) => {
  const exact = account('merchant');
  const registeredWallet = wallet({ accounts: [exact] });
  const unregister = register(registeredWallet);
  t.after(unregister);
  assert.equal(selectSolanaAccount(registeredWallet, 'merchant'), exact);
  registeredWallet.accounts = [];
  assert.throws(() => selectSolanaAccount(registeredWallet, 'merchant'), /exact authorized/);
  registeredWallet.accounts = [exact];
  unregister();
  assert.deepEqual(getSolanaAccounts(registeredWallet), []);
});

test('rejects ambiguous accounts and unsupported capability options', (t) => {
  const registeredWallet = wallet({ accounts: [account('merchant'), account('merchant')] });
  t.after(register(registeredWallet));
  assert.throws(() => selectSolanaAccount(registeredWallet, 'merchant'), /exact authorized/);
  assert.throws(() => getSolanaWallets({ chain: 'solana:mainnet-beta' }), /Unsupported/);
  assert.throws(() => getSolanaWallets({ feature: 'solana:signMessage' }), /Unsupported/);
  assert.throws(() => getSolanaWallets({ transactionVersion: '0' }), /Unsupported/);
});
