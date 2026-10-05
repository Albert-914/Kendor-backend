// Runs the whole order flow with mock payments and a mock supplier.
// Start with: npm test
process.env.PAYMENT_MODE = 'mock';
process.env.SUPPLIER_MODE = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./server');
const dbModule = require('./db');
const payments = require('./payments');
const supplier = require('./supplier');

let server, base, db;

test.before(async () => {
  db = dbModule.open(':memory:');
  server = require('http').createServer(createApp({ db }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { supplier.mock.calls.length = 0; });

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = (path) => fetch(base + path);

async function webhook(event, { badSignature = false } = {}) {
  const raw = JSON.stringify(event);
  const sig = badSignature ? 'deadbeef' : payments.sign(raw);
  return fetch(base + '/api/paystack/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig }, body: raw });
}
const paid = (reference, amount) => ({ event: 'charge.success', data: { reference, status: 'success', currency: 'GHS', amount } });

async function waitFor(reference, status) {
  for (let i = 0; i < 40; i++) {
    const { order } = await (await get(`/api/orders/${reference}`)).json();
    if (order.status === status) return order;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('order never reached ' + status);
}

async function newDataOrder(extra = {}) {
  const res = await post('/api/orders', { type: 'data', network: 'mtn', bundleId: 'mtn-1gb', phone: '024 123 4567', ...extra });
  return { res, body: await res.json() };
}

test('creates an order and takes the price from the server', async () => {
  const { res, body } = await newDataOrder({ amount: 0.01, price: 0.01 }); // cheating attempt
  assert.equal(res.status, 201);
  assert.equal(body.amount, 5.5);
  assert.match(body.reference, /^KD-[A-Z0-9]{8}$/);
  assert.ok(body.authorizationUrl);
  assert.equal(db.get(body.reference).amount_pesewas, 550);
});

test('rejects a number that is not on the chosen network', async () => {
  const { res, body } = await newDataOrder({ phone: '0201234567' }); // Telecel number, MTN chosen
  assert.equal(res.status, 400);
  assert.match(body.error, /not a MTN number/);
});

test('rejects bad input', async () => {
  assert.equal((await post('/api/orders', { type: 'data', network: 'mtn', bundleId: 'nope', phone: '0241234567' })).status, 400);
  assert.equal((await post('/api/orders', { type: 'data', network: 'mtn', bundleId: 'telecel-1gb', phone: '0241234567' })).status, 400);
  assert.equal((await post('/api/orders', { type: 'airtime', network: 'mtn', amount: 9999, phone: '0241234567' })).status, 400);
  assert.equal((await post('/api/orders', { type: 'airtime', network: 'mtn', amount: 'abc', phone: '0241234567' })).status, 400);
  assert.equal((await post('/api/orders', { type: 'data', network: 'mtn', bundleId: 'mtn-1gb', phone: '123' })).status, 400);
});

test('a webhook with a bad signature is refused and nothing is delivered', async () => {
  const { body } = await newDataOrder();
  const res = await webhook(paid(body.reference, 550), { badSignature: true });
  assert.equal(res.status, 401);
  assert.equal(db.get(body.reference).status, 'pending');
  assert.equal(supplier.mock.calls.length, 0);
});

test('a paid order is delivered exactly once, even if Paystack repeats the webhook', async () => {
  const { body } = await newDataOrder();
  const results = await Promise.all([1, 2, 3].map(() => webhook(paid(body.reference, 550))));
  results.forEach((r) => assert.equal(r.status, 200));
  const order = await waitFor(body.reference, 'delivered');
  assert.equal(order.title, '1GB MTN data bundle');
  assert.equal(supplier.mock.calls.length, 1);
  assert.equal(supplier.mock.calls[0].gb, 1);
  assert.equal(supplier.mock.calls[0].phone, '0241234567');
  assert.equal(db.get(body.reference).supplier_ref, 'MOCK-' + body.reference);
});

test('a payment for the wrong amount is not delivered', async () => {
  const { body } = await newDataOrder();
  await webhook(paid(body.reference, 100)); // paid GHS 1 for a GHS 5.50 bundle
  assert.equal(db.get(body.reference).status, 'failed');
  assert.equal(db.get(body.reference).error, 'payment_mismatch');
  assert.equal(supplier.mock.calls.length, 0);
});

test('airtime orders are delivered with the right amount', async () => {
  const res = await post('/api/orders', { type: 'airtime', network: 'telecel', amount: 10, phone: '0501234567' });
  const body = await res.json();
  assert.equal(res.status, 201);
  await webhook(paid(body.reference, 1000));
  await waitFor(body.reference, 'delivered');
  assert.equal(supplier.mock.calls[0].kind, 'airtime');
  assert.equal(supplier.mock.calls[0].amountPesewas, 1000);
});

test('an unknown supplier outcome goes to review, not to delivered or failed', async () => {
  const original = supplier.mock.sendData;
  supplier.mock.sendData = async () => ({ ok: false, unknown: true, error: 'timeout' });
  try {
    const { body } = await newDataOrder();
    await webhook(paid(body.reference, 550));
    for (let i = 0; i < 40 && db.get(body.reference).status !== 'review'; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(db.get(body.reference).status, 'review');
    // customers just see "processing"
    const { order } = await (await get(`/api/orders/${body.reference}`)).json();
    assert.equal(order.status, 'processing');
  } finally { supplier.mock.sendData = original; }
});

test('status lookup works by reference and phone, and hides the full number', async () => {
  const { body } = await newDataOrder({ phone: '0551112233' });
  await webhook(paid(body.reference, 550));
  await waitFor(body.reference, 'delivered');

  const byRef = await (await get(`/api/orders/${body.reference.toLowerCase()}`)).json();
  assert.equal(byRef.order.status, 'delivered');
  assert.equal(byRef.order.phone, '055 *** 233');
  assert.equal(JSON.stringify(byRef).includes('0551112233'), false);

  const byPhone = await (await get('/api/orders/lookup?phone=055%201112233')).json();
  assert.equal(byPhone.orders.length, 1);
  assert.equal((await get('/api/orders/KD-NOTREAL1')).status, 404);
});

test('admin routes need the admin token', async () => {
  assert.equal((await get('/api/admin/orders')).status, 401);
});
