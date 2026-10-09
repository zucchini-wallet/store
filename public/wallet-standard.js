import { getWallets } from '@wallet-standard/app';

// Discovery uses the maintained Wallet Standard register-wallet/app-ready registry:
// https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/app/src/wallets.ts
// Wallet/account chains and features are separate capabilities in the standard.
const SOLANA_CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'];
const SIGNING_METHODS = {
  'solana:signAndSendTransaction': 'signAndSendTransaction',
  'solana:signTransaction': 'signTransaction',
};

/** Initialize discovery and expose register/unregister subscriptions. Never connects a wallet. */
export function getWalletRegistry() {
  return getWallets();
}

function capabilities({
  chain = 'solana:mainnet',
  feature = 'solana:signAndSendTransaction',
  transactionVersion = 'legacy',
} = {}) {
  if (
    !SOLANA_CHAINS.includes(chain) ||
    !Object.hasOwn(SIGNING_METHODS, feature) ||
    !['legacy', 0, 1].includes(transactionVersion)
  )
    throw Error('Unsupported Solana wallet capability request');
  return { chain, feature, transactionVersion };
}

function supportsWallet(wallet, { chain, feature, transactionVersion }) {
  const signing = wallet?.features?.[feature];
  const connect = wallet?.features?.['standard:connect'];
  return (
    wallet?.version === '1.0.0' &&
    Array.isArray(wallet.chains) &&
    wallet.chains.includes(chain) &&
    Array.isArray(wallet.accounts) &&
    connect?.version === '1.0.0' &&
    typeof connect.connect === 'function' &&
    signing?.version === '1.0.0' &&
    typeof signing[SIGNING_METHODS[feature]] === 'function' &&
    Array.isArray(signing.supportedTransactionVersions) &&
    signing.supportedTransactionVersions.includes(transactionVersion)
  );
}

/** Registered wallets capable of the requested transfer, including wallets awaiting authorization. */
export function getSolanaWallets(options) {
  const requested = capabilities(options);
  return getWalletRegistry()
    .get()
    .filter((wallet) => supportsWallet(wallet, requested));
}

/** Accounts already authorized by this wallet, with exact chain and signing feature support. */
export function getSolanaAccounts(wallet, options) {
  const requested = capabilities(options);
  if (!getWalletRegistry().get().includes(wallet) || !supportsWallet(wallet, requested)) return [];
  return wallet.accounts.filter(
    (account) =>
      typeof account?.address === 'string' &&
      account.address.length > 0 &&
      Array.isArray(account.chains) &&
      account.chains.includes(requested.chain) &&
      Array.isArray(account.features) &&
      account.features.includes(requested.feature),
  );
}

/** Return the original authorized account object; never substitute the wallet's first account. */
export function selectSolanaAccount(wallet, address, options) {
  if (typeof address !== 'string' || !address)
    throw Error('An exact Solana account address is required');
  const matches = getSolanaAccounts(wallet, options).filter(
    (account) => account.address === address,
  );
  if (matches.length !== 1)
    throw Error('Select the exact authorized Solana account for the requested chain and feature');
  return matches[0];
}
