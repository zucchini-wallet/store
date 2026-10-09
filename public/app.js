import { createZucchiniClient, discoverZucchiniProvider } from '@zucchinifi/dapp-sdk/zcash';
const $ = (id) => document.getElementById(id),
  countries = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => {
  const regions = {
    GLC: 'Gulf countries',
    MENA: 'Middle East & North Africa',
    WW: 'Worldwide',
    GC: 'Provider region GC',
    LM: 'Provider region LM',
    ZZ: 'Unspecified region',
  };
  if (regions[code]) return regions[code];
  try {
    return countries.of(code) ?? code;
  } catch {
    return code === 'GLC' ? 'Gulf countries' : code;
  }
};
const flag = (code) =>
  /^[A-Z]{2}$/.test(code)
    ? String.fromCodePoint(...[...code].map((c) => 127397 + c.charCodeAt(0)))
    : '◈';
let config,
  products = [],
  selected,
  offset = 0,
  total = 0,
  searchTimer,
  loadVersion = 0,
  category = '',
  current,
  client,
  connected = false,
  walletNetwork,
  walletBusy = false,
  walletGeneration = 0,
  walletListeners = [],
  busy = false,
  poll,
  toastTimer,
  recoverySaved = false;
const sessions = () => {
  try {
    return JSON.parse(localStorage.getItem('zucchini-store-orders') ?? '[]')
      .filter((o) => /^[a-f0-9-]{36}$/.test(o.id) && /^[A-Za-z0-9_-]{43}$/.test(o.token))
      .slice(0, 20);
  } catch {
    return [];
  }
};
const save = (session) => {
  try {
    localStorage.setItem(
      'zucchini-store-orders',
      JSON.stringify([session, ...sessions().filter((o) => o.id !== session.id)].slice(0, 20)),
    );
    return true;
  } catch {
    toast('Browser storage unavailable. Copy your private order link.');
    return false;
  }
};
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 3500);
}
function error(id, e) {
  $(id).textContent = e.message ?? String(e);
  $(id).hidden = false;
}
async function api(path, body, token) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error ?? 'Please try again.');
  return value;
}
function show(dialog) {
  for (const d of document.querySelectorAll('dialog[open]')) if (d !== dialog) d.close();
  dialog.showModal();
}
const cash = (value, currency) => {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
};
function info(title, paragraphs) {
  $('info-title').textContent = title;
  $('info-body').replaceChildren(
    ...paragraphs.map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }),
  );
  show($('info-dialog'));
}
const walletReady = (network) => connected && walletNetwork === network;
function renderWallet() {
  $('connect-wallet').disabled = !config || walletBusy || busy;
  $('connect-wallet').textContent = walletBusy
    ? 'Waiting for wallet…'
    : connected
      ? 'Disconnect wallet'
      : 'Connect wallet';
  $('connect-wallet').title = connected ? `Zucchini Wallet connected · ${walletNetwork}` : '';
}
function resetWallet() {
  walletGeneration++;
  for (const unsubscribe of walletListeners) unsubscribe();
  walletListeners = [];
  connected = false;
  walletNetwork = undefined;
  client = undefined;
  renderWallet();
  if (current) renderOrder();
}
async function checkWalletNetwork(expectedNetwork) {
  const activeClient = client,
    generation = walletGeneration;
  if (!activeClient) throw Error('Connect your wallet again before continuing.');
  let network;
  try {
    network = await activeClient.network();
  } catch (e) {
    if (generation === walletGeneration && activeClient === client) resetWallet();
    throw e;
  }
  if (generation !== walletGeneration || activeClient !== client)
    throw Error('Wallet connection changed. Connect again before continuing.');
  if (network !== expectedNetwork) {
    resetWallet();
    throw Error(`Switch your wallet to ${expectedNetwork} and connect again.`);
  }
  walletNetwork = network;
}
async function connectWallet(expectedNetwork) {
  const provider = discoverZucchiniProvider();
  if (!provider) {
    info('Open in a wallet-enabled browser.', [
      'Install Zucchini Wallet and open this store in a browser where the wallet is available. Unlock the wallet, then choose Connect wallet.',
      config.checkoutReady
        ? 'Connecting does not send a payment. You approve payment separately in your wallet.'
        : 'Connecting does not send a payment. Purchases are currently unavailable.',
    ]);
    return;
  }
  resetWallet();
  const generation = walletGeneration;
  client = createZucchiniClient(provider);
  walletListeners = ['disconnect', 'accountsChanged'].map((event) => client.on(event, resetWallet));
  try {
    const connection = await client.connect({ permissions: ['send_transaction'] });
    if (generation !== walletGeneration) throw Error('Wallet connection changed. Please retry.');
    if (!connection.connected) throw Error('Connection was declined.');
    if (!connection.approvedPermissions?.includes('send_transaction'))
      throw Error('Allow payment requests in Zucchini Wallet to connect to the store.');
    await checkWalletNetwork(expectedNetwork);
    connected = true;
    toast('Zucchini Wallet connected');
  } catch (e) {
    resetWallet();
    throw e;
  }
}
$('connect-wallet').onclick = async () => {
  if (!config || walletBusy || busy) return;
  walletBusy = true;
  renderWallet();
  try {
    if (connected) {
      await client.disconnect();
      resetWallet();
      toast('Wallet disconnected');
    } else await connectWallet(current?.network ?? config.network);
  } catch (e) {
    info('Wallet connection', [e.message]);
  } finally {
    walletBusy = false;
    renderWallet();
    if (current) renderOrder();
  }
};
const infoContent = {
  privacy: [
    'Privacy, by choice.',
    'We process the gift card, payment amount and order memo to confirm payment and fulfill your order. You can use checkout without a store account.',
    'If you choose email delivery, we share your email and delivery message with Resend. The gift-card provider receives our fulfillment email, the selected card and our order reference.',
    'Brand images are served by the gift-card provider and may expose your IP address to that provider. We do not add analytics or advertising trackers, sell your data, or use it for advertising.',
    'Your private order link grants access to your card. Keep it safe. Operational records are kept for fulfillment and support; ask support about deletion. Zcash blockchain records cannot be deleted.',
  ],
  terms: [
    'Purchase terms',
    'Check the country, brand, currency and amount before paying. Gift cards can be used only under the issuer’s redemption terms. We are a reseller, and brands do not endorse Zucchini Store.',
    'The Zcash total is locked for this order’s payment window. Your wallet also charges a network fee. Payment confirmation can take several minutes before digital delivery.',
    'Issued gift cards generally cannot be cancelled or returned. If payment arrives late, is incomplete, exceeds the total, or card fulfillment fails, contact support for review. A new payment or a provider balance refund does not automatically refund Zcash.',
    'Refunds are reviewed and sent to a Zcash address you provide after payment is verified. We show completion only when a refund has been recorded. Close the page safely using your private order link.',
  ],
  support: [
    'We’re here to help.',
    'Keep your order reference and contact ' +
      (config?.supportEmail || 'the store operator') +
      '. Never send your seed phrase or viewing key.',
    'If a wallet request was interrupted, check wallet Activity and your order status before trying to pay again.',
  ],
};
for (const button of document.querySelectorAll('[data-info]'))
  button.onclick = () => {
    const content =
      config.giftCardProvider === 'cryptorefills' &&
      ['privacy', 'terms'].includes(button.dataset.info)
        ? [
            button.dataset.info === 'privacy' ? 'Privacy' : 'Purchase terms',
            'Cryptorefills is the seller and delivers to your real email. We share your email, customer IP and selected product with Cryptorefills. Their terms and privacy policy apply.',
            'Zucchini converts your shielded ZEC to Solana USDC to pay the order. Conversion, late payments and refunds require review; a provider refund does not automatically refund ZEC. Your private recovery link grants access to your order.',
          ]
        : infoContent[button.dataset.info];
    info(content[0], content.slice(1));
  };
$('how').onclick = () =>
  info('Three small steps.', [
    'Choose a gift card for the country where it will be redeemed. Review the amount and connect your wallet.',
    'Connect first, then confirm payment. We never ask for your seed phrase.',
    config.giftCardProvider === 'cryptorefills'
      ? 'After Zcash confirmations and conversion, Cryptorefills delivers to your required email. Save your private order link to return later.'
      : 'After Zcash confirmations, we order the card and display its details here. Save your private order link to return later. Email delivery is optional.',
  ]);
for (const button of document.querySelectorAll('[data-close]'))
  button.onclick = () => button.closest('dialog').close();
for (const d of document.querySelectorAll('dialog'))
  d.addEventListener('click', (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        d.close();
    }
  });
async function loadCatalog(append = false) {
  const version = ++loadVersion;
  $('catalog-error').hidden = true;
  try {
    const data = await api(
      `/api/catalog?country=${encodeURIComponent($('country').value || 'US')}&q=${encodeURIComponent($('search').value)}&category=${encodeURIComponent(category)}&offset=${append ? offset : 0}`,
    );
    if (version !== loadVersion) return;
    if (!$('country').options.length) {
      for (const code of data.countries) {
        const option = new Option(`${flag(code)} ${countryName(code)}`, code);
        $('country').add(option);
      }
      const preferred = localStorage.getItem('zucchini-store-country') ?? 'US';
      $('country').value = data.countries.includes(preferred) ? preferred : data.countries[0];
      if ($('country').value !== 'US') return loadCatalog();
    }
    products = append ? [...products, ...data.items] : data.items;
    total = data.total;
    offset = products.length;
    renderProducts();
    $('result-count').textContent =
      `${total.toLocaleString()} brands in ${countryName($('country').value)}`;
    $('more').hidden = offset >= total;
  } catch (e) {
    error('catalog-error', e);
    $('result-count').textContent = 'The collection could not be loaded.';
  }
}
function renderProducts() {
  $('products').replaceChildren(
    ...products.map((v) => {
      const b = document.createElement('button');
      b.className = 'product';
      b.setAttribute('aria-label', `Choose ${v.name}`);
      const art = document.createElement('div');
      art.className = 'product-art';
      const img = new Image();
      img.alt = v.brandName;
      img.loading = 'lazy';
      if (/^https:\/\/0fiat\.com\//.test(v.iconUrl)) img.src = v.iconUrl;
      img.onerror = () => {
        const fallback = document.createElement('span');
        fallback.className = 'fallback';
        fallback.textContent = v.brandName.slice(0, 2);
        img.replaceWith(fallback);
      };
      art.append(img);
      const tag = document.createElement('span');
      tag.className = 'product-type';
      tag.textContent = 'DIGITAL GIFT CARD';
      art.append(tag);
      const text = document.createElement('div');
      text.className = 'product-text';
      const title = document.createElement('strong');
      title.textContent = v.brandName;
      const sub = document.createElement('p');
      sub.textContent = v.name === v.brandName ? countryName(v.countryCode) : v.name;
      const amount = document.createElement('p');
      amount.className = 'value';
      amount.textContent =
        v.minAmount === v.maxAmount
          ? cash(v.minAmount, v.currency)
          : `${cash(v.minAmount, v.currency)} — ${cash(v.maxAmount, v.currency)}`;
      text.append(title, sub, amount);
      b.append(art, text);
      b.onclick = () => openProduct(v);
      return b;
    }),
  );
  if (!products.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No matches yet. Try another brand or country.';
    $('products').append(p);
  }
}
function openProduct(v) {
  selected = v;
  const variants = v.variants ?? [v];
  $('variant-label').hidden = variants.length < 2;
  $('variant').replaceChildren(
    ...variants.map((a) => new Option(a.name + ' · ' + a.currency, a.voucherId)),
  );
  $('variant').value = v.voucherId;
  $('variant').onchange = () => {
    const a = variants.find((x) => x.voucherId === Number($('variant').value));
    updateProduct(a);
  };
  updateProduct(v);
  show($('product-dialog'));
}
function updateProduct(v) {
  selected = v;
  $('quote-error').hidden = true;
  $('product-title').textContent = v.brandName;
  $('product-country').textContent = countryName(v.countryCode) + ' · ' + v.currency;
  $('product-description').textContent = v.name;
  $('product-icon').src = v.iconUrl;
  $('fixed-amount').hidden = v.denominationMode !== 'FIXED';
  $('flexible-amount').hidden = v.denominationMode === 'FIXED';
  $('fixed-amount').replaceChildren(
    ...(v.denominations ?? []).map((n) => new Option(cash(n, v.currency), n)),
  );
  $('flexible-amount').min = v.minAmount;
  $('flexible-amount').max = v.maxAmount;
  $('flexible-amount').value = v.minAmount;
  $('amount-hint').textContent =
    `Redeemable in ${countryName(v.countryCode)}. ${v.denominationMode === 'FIXED' ? 'Choose a listed value.' : `Between ${cash(v.minAmount, v.currency)} and ${cash(v.maxAmount, v.currency)}.`}`;
  $('get-quote').disabled = !config.checkoutReady;
  $('disabled-message').hidden = config.checkoutReady;
  $('email-opt').disabled = !config.emailAvailable;
  $('email-opt').checked = false;
  const cr = config.giftCardProvider === 'cryptorefills';
  $('email').hidden = !cr;
  $('email').required = cr;
  $('email-hint').textContent = cr
    ? 'Required for Cryptorefills delivery. No newsletter enrollment.'
    : 'Optional. Your card will also be available on your order page.';
  $('cryptorefills-disclosure').hidden = !cr;
  for (const id of ['provider-terms', 'provider-privacy']) {
    $(id).required = cr;
    $(id).checked = false;
  }
  $('accept-terms').checked = false;
}
$('email-opt').onchange = () => {
  const required = config.giftCardProvider === 'cryptorefills';
  $('email').hidden = !required && !$('email-opt').checked;
  $('email').required = required || $('email-opt').checked;
};
$('quote-form').onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  $('quote-error').hidden = true;
  renderWallet();
  $('get-quote').disabled = true;
  $('get-quote').textContent = 'Getting your price…';
  try {
    const data = await api('/api/orders', {
      voucherId: selected.voucherId,
      amount:
        selected.denominationMode === 'FIXED'
          ? $('fixed-amount').value
          : $('flexible-amount').value,
      ...(config.fundingMode === 'shielded_buffer'
        ? { replyAddress: $('reply-address').value.trim() }
        : {}),
      emailOptIn: $('email-opt').checked,
      ...(config.giftCardProvider === 'cryptorefills'
        ? {
            email: $('email').value,
            providerTermsAccepted: $('provider-terms').checked,
            providerPrivacyAccepted: $('provider-privacy').checked,
          }
        : $('email-opt').checked
          ? { email: $('email').value }
          : {}),
    });
    current = { ...data.order, token: data.token };
    recoverySaved = save({ id: current.id, token: current.token, brand: current.brand });
    renderOrder();
    show($('checkout-dialog'));
    startPoll();
  } catch (e) {
    error('quote-error', e);
  } finally {
    busy = false;
    renderWallet();
    $('get-quote').disabled = !config.checkoutReady;
    $('get-quote').textContent = 'Review Zcash total →';
  }
};
$('country').onchange = () => {
  localStorage.setItem('zucchini-store-country', $('country').value);
  void loadCatalog();
};
$('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadCatalog(), 250);
  for (const b of $('filters').children)
    b.classList.toggle('active', b.dataset.search === category);
};
$('more').onclick = () => loadCatalog(true);
for (const b of $('filters').children)
  b.onclick = () => {
    category = b.dataset.search;
    for (const c of $('filters').children) c.classList.toggle('active', c === b);
    void loadCatalog();
  };
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    $('search').focus();
  }
});
function renderOrder() {
  if (!current) return;
  const o = current;
  const orderWalletReady = walletReady(o.network);
  $('checkout-provider').hidden = o.giftCardProvider !== 'cryptorefills';
  renderWallet();
  $('checkout-error').hidden = true;
  $('checkout-title').textContent =
    o.state === 'delivered'
      ? 'Your gift is ready.'
      : o.state === 'fulfilling'
        ? 'Getting your card.'
        : 'A good choice.';
  $('checkout-brand').textContent = o.brand;
  $('zec-total').textContent =
    `${(Number(o.amountZatoshis) / 1e8).toLocaleString('en', { maximumFractionDigits: 8 })} ZEC`;
  $('usd-total').textContent = cash(o.totalUsd, 'USD');
  $('face-total').textContent = cash(o.faceAmount, o.currency);
  $('redeem-country').textContent = countryName(o.country);
  $('quote-expiry').textContent =
    o.state === 'quoted'
      ? `Quote available until ${new Date(o.quoteExpiresAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
      : `Pay before ${new Date(o.expiresAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  $('order-reference').textContent = 'Order ' + o.id;
  $('cancel-order').hidden = o.state !== 'quoted';
  $('refund-order').hidden =
    !['refund_review', 'support_required'].includes(o.state) &&
    !['underpaid', 'overpaid', 'late_payment', 'reorg_review'].includes(o.receipt?.state);
  $('review').hidden = ['delivered', 'fulfilling'].includes(o.state);
  const receipt = o.receipt;
  const labels = {
    verification_unavailable:
      'Payment verification is catching up. Your order is saved; please wait.',
    awaiting_payment: 'Waiting for your payment. This page will update automatically.',
    detected: 'Payment received. Waiting for confirmation.',
    confirming: `Payment received · ${receipt?.confirmations} of ${receipt?.requiredConfirmations} confirmations.`,
    paid: 'Payment confirmed. We’re preparing your gift card.',
    underpaid: 'The received payment is below your total. Contact support before sending more.',
    overpaid: 'We received more than the total. Contact support to review the extra amount.',
    late_payment: 'Your payment arrived after the payment window. Contact support for review.',
    expired: 'The payment window has ended. Check wallet Activity before starting a new order.',
    reorg_review: 'Payment confirmation changed. We’re reviewing this order.',
  };
  $('order-status').textContent =
    o.state === 'quoted'
      ? orderWalletReady
        ? 'Wallet connected. You can now confirm the payment.'
        : 'Connect your wallet first. Payment is a separate step.'
      : o.state === 'delivered'
        ? o.emailOptIn
          ? o.emailSent
            ? 'Your card is ready below. An email copy has been sent.'
            : 'Your card is ready below. Your email copy is being prepared.'
          : 'Your card is ready below. Keep the details private.'
        : o.state === 'fulfilling'
          ? 'Payment confirmed. The provider is issuing your card. You can close this page and return with your order link.'
          : o.state === 'refund_submitted'
            ? 'Support recorded a Zcash refund submission. Check your wallet for confirmation.'
            : o.state === 'refund_review'
              ? 'The provider could not issue your card. Contact support for a Zcash refund review.'
              : o.state === 'support_required'
                ? 'This order needs a review. Contact support with your order reference.'
                : o.state === 'cancelled'
                  ? 'Quote cancelled. No payment was requested.'
                  : (labels[receipt?.state] ?? 'Checking your payment.');
  $('checkout-action').hidden = o.state !== 'quoted';
  $('checkout-action').disabled = busy || walletBusy || now() >= o.quoteExpiresAt;
  $('checkout-action').textContent = busy
    ? 'Waiting for wallet…'
    : now() >= o.quoteExpiresAt
      ? 'Quote expired'
      : orderWalletReady
        ? 'Confirm payment in Zucchini'
        : 'Connect Zucchini Wallet';
  for (const [i, li] of [...$('steps').children].entries())
    li.classList.toggle(
      'active',
      i === (o.state === 'quoted' ? (orderWalletReady ? 1 : 0) : o.state === 'delivered' ? 2 : 1),
    );
  $('gift-details').hidden = o.state !== 'delivered';
  if (o.state === 'delivered') renderCard(o.card);
}
const now = () => Math.floor(Date.now() / 1000);
function renderCard(card) {
  const dl = document.createElement('dl');
  const values = Array.isArray(card)
    ? card
    : typeof card === 'object'
      ? Object.entries(card)
      : [['Gift card', card]];
  for (const entry of values) {
    if (!Array.isArray(entry)) {
      const dt = document.createElement('dt');
      dt.textContent = 'Gift-card details';
      const dd = document.createElement('dd');
      dd.textContent =
        typeof entry === 'object'
          ? Object.entries(entry)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')
          : String(entry);
      dl.append(dt, dd);
      continue;
    }
    const [k, v] = entry;
    const dt = document.createElement('dt');
    dt.textContent = k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    const dd = document.createElement('dd');
    dd.textContent =
      typeof v === 'object'
        ? Object.entries(v)
            .map(([a, b]) => `${a}: ${b}`)
            .join('\n')
        : String(v);
    dl.append(dt, dd);
  }
  const b = document.createElement('button');
  b.textContent = 'Copy card details';
  b.onclick = () => copy(JSON.stringify(card, null, 2), 'Card details copied');
  $('gift-details').replaceChildren(dl, b);
}
async function copy(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
    return true;
  } catch {
    info('Save this privately.', [value]);
    return false;
  }
}
$('copy-order').onclick = async () => {
  recoverySaved =
    (await copy(
      `${location.origin}/#order=${current.id}&key=${current.token}`,
      'Private order link copied',
    )) || recoverySaved;
};
$('checkout-action').onclick = async () => {
  if (busy || walletBusy || !current || current.state !== 'quoted') return;
  busy = true;
  renderOrder();
  try {
    if (!walletReady(current.network)) {
      await connectWallet(current.network);
      return;
    }
    if (!recoverySaved)
      throw Error('Save your private order link before paying. Browser storage is unavailable.');
    await checkWalletNetwork(current.network);
    const result = await api(`/api/orders/${current.id}/pay`, {}, current.token);
    current = { ...result.order, token: current.token };
    save({ id: current.id, token: current.token, brand: current.brand });
    renderOrder();
    // A persisted payment request is never automatically replayed after interruption.
    await checkWalletNetwork(current.network);
    const submission = await client.requestPayment(current.paymentUri);
    const updated = await api(
      `/api/orders/${current.id}/submitted`,
      { txid: submission.txid },
      current.token,
    );
    current = { ...updated.order, token: current.token };
    toast('Payment sent. Checking confirmation.');
  } catch (e) {
    error('checkout-error', e);
    if (current.state === 'payment_pending')
      $('order-status').textContent =
        'The wallet request ended. Check wallet Activity and your order status before sending another payment. Your order is saved.';
  } finally {
    busy = false;
    const message = $('checkout-error').hidden ? undefined : $('checkout-error').textContent;
    renderOrder();
    if (message) error('checkout-error', Error(message));
  }
};
$('cancel-order').onclick = async () => {
  try {
    const data = await api(`/api/orders/${current.id}/cancel`, {}, current.token);
    current = { ...data.order, token: current.token };
    renderOrder();
    toast('Quote cancelled');
  } catch (e) {
    error('checkout-error', e);
  }
};
$('refund-order').onclick = () => {
  const form = document.createElement('form'),
    label = document.createElement('label'),
    input = document.createElement('input'),
    button = document.createElement('button'),
    p = document.createElement('p');
  label.textContent = 'Your Zcash unified refund address';
  input.required = true;
  input.placeholder = current.network === 'mainnet' ? 'u1…' : 'utest1…';
  input.style.width = '100%';
  button.className = 'primary';
  button.textContent = 'Request refund review';
  p.className = 'hint';
  p.textContent =
    'Support verifies the payment before sending a refund. This request does not send funds.';
  label.append(input);
  form.append(label, p, button);
  $('info-title').textContent = 'Refund review';
  $('info-body').replaceChildren(form);
  show($('info-dialog'));
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/orders/${current.id}/refund`, { address: input.value.trim() }, current.token);
      $('info-dialog').close();
      toast('Refund review requested');
    } catch (e) {
      p.textContent = e.message;
    }
  };
};
async function refreshOrder() {
  if (!current || busy) return;
  try {
    const data = await api(`/api/orders/${current.id}`, undefined, current.token);
    current = { ...data.order, token: current.token };
    renderOrder();
  } catch {
    if ($('checkout-dialog').open)
      $('order-status').textContent =
        'Could not refresh this order. We’ll keep trying. Your private order link is safe to use later.';
  }
}
function startPoll() {
  clearInterval(poll);
  poll = setInterval(refreshOrder, 10000);
}
async function openOrder(id, token) {
  try {
    const data = await api(`/api/orders/${id}`, undefined, token);
    current = { ...data.order, token };
    recoverySaved = save({ id, token, brand: current.brand });
    renderOrder();
    show($('checkout-dialog'));
    startPoll();
  } catch (e) {
    info('Order unavailable.', [e.message]);
  }
}
$('orders').onclick = () => {
  const list = sessions();
  if (!list.length)
    return info('Your orders.', [
      'No saved orders on this browser yet. Once you review a gift card, you can save its private order link.',
    ]);
  $('info-title').textContent = 'Your orders';
  $('info-body').replaceChildren(
    ...list.map((o) => {
      const b = document.createElement('button');
      b.className = 'secondary';
      b.style.width = '100%';
      b.style.margin = '12px 0';
      b.textContent = `${o.brand ?? 'Gift card'} · ${o.id.slice(0, 8)}`;
      b.onclick = () => openOrder(o.id, o.token);
      return b;
    }),
  );
  show($('info-dialog'));
};
try {
  config = await api('/api/config');
  renderWallet();
  for (const brand of document.querySelectorAll('[data-cryptorefills-brand]'))
    if (brand.id !== 'checkout-provider')
      brand.hidden = config.giftCardProvider !== 'cryptorefills';
  $('availability').textContent = config.checkoutReady
    ? 'Pay with Zcash'
    : config.catalogPreview
      ? 'Preview catalog · purchases unavailable'
      : 'Browse now · checkout coming soon';
  if (config.network === 'testnet') $('availability').textContent = 'Testnet · no real purchases';
  $('reply-label').hidden = config.fundingMode !== 'shielded_buffer';
  $('catalog-preview').hidden = !config.catalogPreview;
  await loadCatalog();
  const hash = new URLSearchParams(location.hash.slice(1));
  if (
    /^[a-f0-9-]{36}$/.test(hash.get('order') ?? '') &&
    /^[A-Za-z0-9_-]{43}$/.test(hash.get('key') ?? '')
  ) {
    history.replaceState(null, '', location.pathname);
    await openOrder(hash.get('order'), hash.get('key'));
  }
} catch (e) {
  error('catalog-error', e);
}
