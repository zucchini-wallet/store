import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture,
  firstId,
  secondId,
  start,
  draft,
  invoice,
  quote,
  owner,
  signature,
} from './fixtures/direct-contract.mjs';

test('delivery requires finalized matching payout and authoritative provider acceptance', async (t) => {
  const f = await fixture(t),
    c = await f.prepare();
  await c.act(firstId, 'begin_payment');
  const verify = f.adapters.verifyPayout,
    get = f.adapters.getInvoice;
  f.adapters.verifyPayout = async () => {
    throw Error('not finalized');
  };
  await assert.rejects(c.act(firstId, 'poll'), /Finalized invoice payment/);
  assert.equal(f.store.get(firstId).state, 'payment_pending');
  assert.equal(f.store.get(firstId).card, undefined);
  assert.equal(f.calls.filter((call) => call[0] === 'getInvoice').length, 0);
  f.time += 15;
  f.adapters.verifyPayout = verify;
  f.adapters.getInvoice = async (o) => {
    const p = await get(o);
    p.payment.accepted = false;
    return p;
  };
  await assert.rejects(c.act(firstId, 'poll'), /payment acceptance/);
  assert.equal(f.store.get(firstId).state, 'fulfilling');
  assert.equal(f.store.get(firstId).card, undefined);
  f.time += 15;
  f.adapters.getInvoice = get;
  await c.act(firstId, 'poll');
  assert.equal(f.store.get(firstId).state, 'delivered');
  assert.deepEqual(f.store.get(firstId).card, { code: 'synthetic-card' });
});

test('provider completion and wallet txid alone cannot substitute for chain payment', async (t) => {
  const f = await fixture(t),
    c = await f.prepare();
  await c.act(firstId, 'begin_payment');
  await c.act(firstId, 'submitted', { txid: 'aa'.repeat(32) });
  const status = f.adapters.swapStatus;
  f.adapters.swapStatus = async (o) => ({ ...(await status(o)), status: 'PROCESSING' });
  await assert.rejects(c.act(firstId, 'poll'), /payment acceptance/);
  assert.equal(f.store.get(firstId).state, 'payment_pending');
  assert.equal(f.store.get(firstId).card, undefined);
  assert.equal(f.calls.filter((call) => call[0] === 'verify').length, 0);
});

test('lost invoice response survives restart without automatic provider creation retry', async (t) => {
  const f = await fixture(t);
  f.adapters.createInvoice = async (o) => {
    f.calls.push(['createInvoice', o.id]);
    throw Error('response lost');
  };
  await assert.rejects(f.coordinator().act(firstId, 'prepare'), /response lost/);
  assert.equal(f.store.get(firstId).direct.state, 'invoice_unknown');
  const c = f.restart();
  await c.tick();
  assert.equal(f.calls.filter((call) => call[0] === 'createInvoice').length, 1);
  f.adapters.createInvoice = async (o) => {
    f.calls.push(['createInvoice', o.id]);
    return invoice(o.id);
  };
  await c.act(firstId, 'recover_invoice');
  assert.deepEqual(
    f.calls.filter((call) => call[0] === 'createInvoice').map((call) => call[1]),
    [firstId, firstId],
  );
  assert.equal(f.store.get(firstId).direct.state, 'invoice_ready');
});

test('lost executable quote response recovers original quote without another quote POST', async (t) => {
  const f = await fixture(t),
    c = f.coordinator();
  await c.act(firstId, 'prepare');
  f.adapters.quoteSwap = async (o) => {
    f.calls.push(['quoteSwap', o.id]);
    throw Error('response lost');
  };
  await assert.rejects(c.act(firstId, 'prepare_swap'), /response lost/);
  assert.equal(f.store.get(firstId).direct.state, 'swap_unknown');
  const restarted = f.restart();
  await restarted.tick();
  assert.equal(f.calls.filter((call) => call[0] === 'quoteSwap').length, 1);
  await restarted.act(firstId, 'recover_swap');
  assert.equal(f.calls.filter((call) => call[0] === 'quoteSwap').length, 1);
  assert.equal(f.calls.filter((call) => call[0] === 'recoverSwap').length, 1);
  assert.equal(f.store.get(firstId).direct.state, 'quote_ready');
});

test('invoice and swap input caps and both deadline windows fail before payment approval', async (t) => {
  for (const failure of ['invoiceAmount', 'invoiceExpiry', 'inputCap', 'settlementWindow']) {
    const f = await fixture(t),
      c = f.coordinator();
    if (failure === 'invoiceAmount')
      f.adapters.createInvoice = async (o) => ({ ...invoice(o.id), amountAtomic: '5000001' });
    if (failure === 'invoiceExpiry')
      f.adapters.createInvoice = async (o) => ({ ...invoice(o.id), expiresAt: start + 719 });
    if (failure === 'inputCap')
      f.adapters.quoteSwap = async (o) => ({ ...quote(o.id), amountInAtomic: '13000001' });
    if (failure === 'settlementWindow')
      f.adapters.quoteSwap = async (o) => ({ ...quote(o.id), deadline: start + 1201 });
    if (failure.startsWith('invoice')) await assert.rejects(c.act(firstId, 'prepare'));
    else {
      await c.act(firstId, 'prepare');
      await assert.rejects(c.act(firstId, 'prepare_swap'));
    }
    assert.equal(f.store.get(firstId).paymentStartedAt, undefined);
    await assert.rejects(c.act(firstId, 'begin_payment'));
  }
  const f = await fixture(t),
    c = await f.prepare();
  f.time = f.store.get(firstId).direct.binding.latestApprovalAt + 1;
  await assert.rejects(c.act(firstId, 'begin_payment'), /expired/);
  assert.equal(f.store.get(firstId).paymentStartedAt, undefined);
});

test('customer cancellation is blocked once payment approval begins', async (t) => {
  const f = await fixture(t),
    c = await f.prepare();
  await c.act(firstId, 'begin_payment');
  await assert.rejects(c.act(firstId, 'cancel'), /underway/);
  assert.equal(f.calls.filter((call) => call[0] === 'cancelInvoice').length, 0);
  assert.equal(f.store.get(firstId).state, 'payment_pending');
});

test('an ambiguous provider cancellation blocks later payment approval across restart', async (t) => {
  const f = await fixture(t),
    c = await f.prepare();
  f.adapters.cancelInvoice = async () => {
    throw Error('cancellation response lost');
  };
  await assert.rejects(c.act(firstId, 'cancel'), /response lost/);
  const restarted = f.restart();
  await assert.rejects(restarted.act(firstId, 'begin_payment'));
  assert.equal(f.store.get(firstId).paymentStartedAt, undefined);
  f.adapters.getInvoice = async (o) => ({
    orderId: 'another-provider-order',
    externalOrderId: o.id,
    state: 'CANCELED',
  });
  await assert.rejects(restarted.act(firstId, 'recover_cancel'), /not confirmed/);
  assert.equal(f.store.get(firstId).direct.state, 'cancel_unknown');
  f.adapters.getInvoice = async (o) => ({
    orderId: o.direct.invoice.orderId,
    externalOrderId: o.id,
    state: 'CANCELED',
  });
  await restarted.act(firstId, 'recover_cancel');
  assert.equal(f.store.get(firstId).state, 'cancelled');
  await assert.rejects(restarted.act(firstId, 'begin_payment'));
});

test('exclusive payout evidence and polling cooldown remain durable across restarts', async (t) => {
  const f = await fixture(t),
    c = await f.prepare();
  await c.act(firstId, 'begin_payment');
  await c.act(firstId, 'poll');
  assert.equal(f.store.get(firstId).state, 'delivered');
  f.store.insert(draft(secondId), 'another-synthetic-capability');
  const second = await f.prepare(secondId);
  await second.act(secondId, 'begin_payment');
  const restarted = f.restart();
  await assert.rejects(restarted.act(secondId, 'poll'), /evidence already assigned/);
  assert.equal(f.store.get(secondId).card, undefined);
  const count = f.calls.filter((call) => call[0] === 'status').length;
  await assert.rejects(f.restart().act(secondId, 'poll'), /cooling down/);
  assert.equal(f.calls.filter((call) => call[0] === 'status').length, count);
  assert.equal(f.store.get(firstId).state, 'delivered');
});

test('changed provider order, recipient or delivery identity never exposes a gift card', async (t) => {
  const f = await fixture(t),
    c = await f.prepare();
  await c.act(firstId, 'begin_payment');
  const get = f.adapters.getInvoice;
  const changes = [
    (p) => {
      p.orderId = 'another-provider-order';
    },
    (p) => {
      p.externalOrderId = secondId;
    },
    (p) => {
      p.payment.recipient = 'wrong-recipient';
    },
    (p) => {
      p.payment.amountAtomic = '4999999';
    },
    (p) => {
      p.delivery.beneficiary = 'other@example.com';
    },
    (p) => {
      p.delivery.brand = 'Another brand';
    },
    (p) => {
      p.delivery.country = 'CA';
    },
    (p) => {
      p.delivery.faceAmount = '50.00';
    },
    (p) => {
      p.delivery.providerProductId = '20000000-0000-4000-8000-000000000001';
    },
    (p) => {
      p.delivery.card = {};
    },
  ];
  for (const change of changes) {
    f.adapters.getInvoice = async (o) => {
      const p = await get(o);
      change(p);
      return p;
    };
    await assert.rejects(c.act(firstId, 'poll'));
    assert.equal(f.store.get(firstId).card, undefined);
    assert.notEqual(f.store.get(firstId).state, 'delivered');
    f.time += 15;
  }
});

test('uncertain deposit notifications retain one wallet submission and cannot restart approval', async (t) => {
  const f = await fixture(t),
    c = await f.prepare();
  await c.act(firstId, 'begin_payment');
  f.adapters.notifyDeposit = async () => {
    f.calls.push(['notify']);
    throw Error('notification response lost');
  };
  await c.act(firstId, 'submitted', { txid: 'aa'.repeat(32) });
  assert.equal(f.store.get(firstId).direct.notificationPending, true);
  const restarted = f.restart();
  await assert.rejects(restarted.act(firstId, 'begin_payment'));
  await restarted.act(firstId, 'submitted', { txid: 'aa'.repeat(32) });
  await assert.rejects(restarted.act(firstId, 'submitted', { txid: 'bb'.repeat(32) }), /changed/);
  assert.equal(f.store.get(firstId).txid, 'aa'.repeat(32));
  assert.equal(f.calls.filter((call) => call[0] === 'notify').length, 2);
});

test('a polling failure cannot overwrite a concurrent terminal or revised order', async (t) => {
  for (const state of ['delivered', 'fulfilling']) {
    const f = await fixture(t),
      c = await f.prepare();
    await c.act(firstId, 'begin_payment');
    f.store.update(firstId, (r) => {
      r.direct.failures = 7;
    });
    f.adapters.swapStatus = async () => {
      f.store.update(firstId, (r) => {
        r.state = state;
        r.direct.revision += 1;
        if (state === 'delivered') r.card = { code: 'concurrently-verified-card' };
      });
      throw Error('old transport result');
    };
    await c.tick();
    const saved = f.store.get(firstId);
    assert.equal(saved.state, state);
    assert.equal(saved.direct.failures, 7);
    if (state === 'delivered') assert.deepEqual(saved.card, { code: 'concurrently-verified-card' });
  }
});
