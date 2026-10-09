import { getWalletRegistry, getSolanaWallets, selectSolanaAccount } from './wallet-standard.js';
import { createOperatorSolana } from './operator-solana.js';
import { createZucchiniClient, discoverZucchiniProvider } from '@zucchinifi/dapp-sdk/zcash';
const el = (id) => document.getElementById(id);
let orders = [];
let busy = false;
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + el('token').value,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    cache: 'no-store',
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error);
  return b;
}
async function load() {
  orders = (await api('/internal/settlements')).orders;
  el('output').textContent = JSON.stringify(orders, null, 2);
}
async function action(name, input = {}) {
  return api('/internal/settlement', { orderId: el('order').value, action: name, input });
}
async function guarded(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (e) {
    el('output').textContent = e.message + ' — reconcile wallet activity before retrying.';
  } finally {
    busy = false;
  }
}
el('load').onclick = () => guarded(load);
el('run').onclick = () =>
  guarded(async () => {
    await action(el('action').value, { txid: el('txid').value });
    await load();
  });
el('send').onclick = () =>
  guarded(async () => {
    await load();
    const order = orders.find((o) => o.id === el('order').value);
    const s = order?.settlement;
    if (!['conversion_ready', 'reply_ready'].includes(s?.state))
      throw Error('No payable Zcash plan; interrupted attempts must be reconciled');
    const provider = discoverZucchiniProvider();
    if (!provider) throw Error('Unlock an existing wallet-enabled browser');
    const wallet = createZucchiniClient(provider);
    const connection = await wallet.connect({ permissions: ['send_transaction'] });
    if (!connection.connected || (await wallet.network()) !== order.network)
      throw Error('Wallet connection/network mismatch');
    const conversion = s.state === 'conversion_ready';
    const plan = conversion
      ? { recipient: s.quote.depositAddress, amountZatoshis: order.amountZatoshis }
      : s.replyPlan;
    await action(conversion ? 'begin_conversion' : 'begin_reply');
    const { txid } = await wallet.requestTransaction({
      ...plan,
      amountZatoshis: BigInt(plan.amountZatoshis),
    });
    el('txid').value = txid;
    await action(conversion ? 'submit_conversion' : 'submit_reply', { txid });
    await load();
  });

// Offline harnesses can explicitly inject a Wallet Standard stub and block-height input.
// No live wallet discovery or RPC/session bridge is installed by this page.
export function configureSolanaOperator({ wallet, getCurrentBlockHeight }) {
  const controller = createOperatorSolana({
    wallet,
    getCurrentBlockHeight,
    getOrder: async (id) => {
      await load();
      return orders.find((o) => o.id === id);
    },
    act: (orderId, name, input = {}) =>
      api('/internal/settlement', { orderId, action: name, input }),
  });
  el('sendSolana').disabled = false;
  el('sendSolana').onclick = () =>
    guarded(async () => {
      await controller.approveTopup(el('order').value);
      await load();
    });
  return controller;
}

// Discovery is read-only. Connecting and signing occur only on the separate approval action.
let solanaWallets = [];
function refreshSolanaWallets() {
  solanaWallets = getSolanaWallets();
  const select = el('solana-wallet');
  select.replaceChildren(
    new Option('Select a compatible wallet', ''),
    ...solanaWallets.map((wallet, i) => new Option(wallet.name, String(i))),
  );
  el('sendSolana').disabled = true;
}
el('refresh-wallets').onclick = refreshSolanaWallets;
el('use-solana-wallet').onclick = () =>
  guarded(async () => {
    const index = el('solana-wallet').value;
    const wallet = index === '' ? undefined : solanaWallets[Number(index)];
    if (!wallet || !getSolanaWallets().includes(wallet))
      throw Error('Select a registered Solana mainnet wallet');
    const signing = wallet.features['solana:signAndSendTransaction'];
    const reviewedWallet = {
      ...wallet,
      features: {
        ...wallet.features,
        'solana:signAndSendTransaction': {
          ...signing,
          async signAndSendTransaction(...inputs) {
            for (const input of inputs)
              if (selectSolanaAccount(wallet, input.account.address) !== input.account)
                throw Error('Wallet account changed; review the buffer account');
            return signing.signAndSendTransaction(...inputs);
          },
        },
      },
    };
    configureSolanaOperator({
      wallet: reviewedWallet,
      getCurrentBlockHeight: async () => {
        const { blockHeight } = await api('/internal/solana-height');
        if (!Number.isSafeInteger(blockHeight) || blockHeight < 0)
          throw Error('Solana height unavailable');
        return blockHeight;
      },
    });
    el('output').textContent =
      'Wallet selected. Review the persisted payment plan and approve it separately. The selected account must match the merchant buffer.';
  });
getWalletRegistry().on('register', refreshSolanaWallets);
getWalletRegistry().on('unregister', refreshSolanaWallets);
refreshSolanaWallets();
