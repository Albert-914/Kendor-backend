// Kendor backend. No packages to install: it uses only what Node already includes.
const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const catalog = require('./catalog');
const phoneUtil = require('./phone');
const dbModule = require('./db');
const paymentsReal = require('./payments');
const supplierReal = require('./supplier');

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newReference() {
  const bytes = crypto.randomBytes(8);
  let s = 'KD-';
  for (const b of bytes) s += REF_CHARS[b % REF_CHARS.length];
  return s;
}

// Counts requests per visitor in a sliding window.
function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return true; }
    recent.push(now);
    hits.set(key, recent);
    return false;
  };
}

// The last address in X-Forwarded-For is the one your host's proxy added, so it
// cannot be faked by the visitor.
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// What customers may see. Internal states are simplified.
function publicOrder(o) {
  const status = ['paid', 'delivering', 'review'].includes(o.status) ? 'processing' : o.status;
  return {
    reference: o.reference,
    type: o.type,
    title: o.title,
    phone: phoneUtil.mask(o.phone),
    amount: o.amount_pesewas / 100,
    status, // pending | processing | delivered | failed
    createdAt: o.created_at,
  };
}

function createApp({ db, payments = paymentsReal, supplier = supplierReal } = {}) {
  const orderLimiter = makeLimiter({ windowMs: 60000, max: 20 });
  const lookupLimiter = makeLimiter({ windowMs: 60000, max: 30 });

  function send(res, status, obj) {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': config.allowedOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(body);
  }

  // ---------- Delivery ----------
  async function deliver(reference) {
    if (!db.claimDelivery(reference)) return; // someone else already has it
    const order = db.get(reference);
    try {
      const args = { reference, network: order.network, phone: order.phone, gb: order.gb, amountPesewas: order.amount_pesewas };
      const result = order.type === 'data' ? await supplier.sendData(args) : await supplier.sendAirtime(args);
      if (result.ok) db.markDelivered(reference, result.supplierRef);
      else if (result.unknown) db.markReview(reference, result.error);
      else db.markFailed(reference, result.error);
    } catch (e) {
      db.markReview(reference, 'exception: ' + e.message);
    }
    const after = db.get(reference);
    console.log(`[order ${reference}] ${after.status}${after.error ? ' - ' + after.error : ''}`);
  }

  // ---------- Paystack webhook ----------
  async function webhook(req, res) {
    const raw = await readBody(req, 1024 * 1024);
    if (!payments.validSignature(raw, req.headers['x-paystack-signature'])) return send(res, 401);
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400); }
    if (event.event !== 'charge.success') return send(res, 200);

    const d = event.data || {};
    const order = d.reference ? db.get(d.reference) : null;
    if (!order) return send(res, 200); // not ours

    const amountOk = d.status === 'success' && d.currency === 'GHS' && d.amount === order.amount_pesewas;
    if (!amountOk) {
      console.warn(`[order ${order.reference}] payment does not match the order, not delivering`);
      if (order.status === 'pending') db.markFailed(order.reference, 'payment_mismatch');
      return send(res, 200);
    }
    try {
      const check = await payments.verify(order.reference);
      if (check && (check.status !== 'success' || check.amount !== order.amount_pesewas)) {
        db.markFailed(order.reference, 'verify_mismatch');
        return send(res, 200);
      }
    } catch (e) {
      console.warn(`[order ${order.reference}] could not verify with Paystack (${e.message}); asking Paystack to retry`);
      return send(res, 500); // Paystack will send the webhook again
    }

    const first = db.markPaid(order.reference);
    send(res, 200); // answer fast, deliver in the background
    if (first) deliver(order.reference);
  }

  // ---------- Create an order ----------
  async function createOrder(req, res) {
    if (orderLimiter(clientIp(req))) return send(res, 429, { error: 'Too many requests. Try again in a minute.' });
    let body;
    try { body = JSON.parse((await readBody(req, 10 * 1024)).toString('utf8') || '{}'); } catch (e) {
      if (e.status) throw e;
      return send(res, 400, { error: 'Invalid request.' });
    }
    const { type, network, bundleId } = body || {};
    const phone = phoneUtil.normalize(body && body.phone);

    if (!['data', 'airtime'].includes(type)) return send(res, 400, { error: 'Choose data or airtime.' });
    if (!catalog.NETWORKS[network]) return send(res, 400, { error: 'Choose a network.' });
    if (!phoneUtil.isValid(phone)) return send(res, 400, { error: 'Enter a valid 10-digit phone number, like 024 123 4567.' });
    if (phoneUtil.detectNetwork(phone) !== network) {
      return send(res, 400, { error: `That number is not a ${catalog.NETWORKS[network].name} number.` });
    }

    let title, amountPesewas, gb = null, bundle = null;
    if (type === 'data') {
      bundle = catalog.findBundle(bundleId);
      if (!bundle || bundle.network !== network) return send(res, 400, { error: 'Choose a bundle.' });
      title = bundle.title;
      gb = bundle.gb;
      amountPesewas = Math.round(bundle.price * 100); // price comes from the server only
    } else {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < catalog.AIRTIME_MIN || amount > catalog.AIRTIME_MAX) {
        return send(res, 400, { error: `Airtime must be between GHS ${catalog.AIRTIME_MIN} and GHS ${catalog.AIRTIME_MAX}.` });
      }
      amountPesewas = Math.round(amount * 100);
      title = `${catalog.NETWORKS[network].name} airtime`;
    }

    const reference = newReference();
    db.insert({ reference, type, network, bundleId: bundle && bundle.id, gb, title, phone, amountPesewas });

    try {
      const pay = await payments.initialize({
        email: `${phone}@${config.customerEmailDomain}`,
        amountPesewas,
        reference,
      });
      send(res, 201, { reference, title, amount: amountPesewas / 100, authorizationUrl: pay.authorizationUrl });
    } catch (e) {
      console.error(`[order ${reference}] could not start payment: ${e.message}`);
      db.markFailed(reference, 'payment_init_failed');
      send(res, 502, { error: 'Could not start the payment. Please try again.' });
    }
  }

  // ---------- Admin (you) ----------
  function isAdmin(req) {
    const given = Buffer.from(String(req.headers['x-admin-token'] || ''));
    const want = Buffer.from(config.adminToken);
    return config.adminToken !== '' && given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  // ---------- Router ----------
  return async function handler(req, res) {
    try {
      if (req.method === 'OPTIONS') return send(res, 204);
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const m = req.method;
      let match;

      if (m === 'POST' && path === '/api/paystack/webhook') return await webhook(req, res);

      if (m === 'GET' && path === '/api/health') {
        return send(res, 200, { ok: true, paymentMode: config.paymentMode, supplierMode: config.supplierMode });
      }

      if (m === 'GET' && path === '/api/bundles') {
        const network = url.searchParams.get('network');
        if (network && !catalog.NETWORKS[network]) return send(res, 400, { error: 'Unknown network.' });
        return send(res, 200, {
          bundles: catalog.listBundles(network).map((b) => ({ id: b.id, network: b.network, gb: b.gb, price: b.price, title: b.title })),
        });
      }

      if (m === 'POST' && path === '/api/orders') return await createOrder(req, res);

      if (m === 'GET' && path === '/api/orders/lookup') {
        if (lookupLimiter(clientIp(req))) return send(res, 429, { error: 'Too many requests. Try again in a minute.' });
        const phone = phoneUtil.normalize(url.searchParams.get('phone'));
        if (!phoneUtil.isValid(phone)) return send(res, 400, { error: 'Enter a valid phone number.' });
        return send(res, 200, { orders: db.byPhone(phone).map(publicOrder) });
      }

      if (m === 'GET' && (match = path.match(/^\/api\/orders\/([A-Za-z0-9-]+)$/))) {
        if (lookupLimiter(clientIp(req))) return send(res, 429, { error: 'Too many requests. Try again in a minute.' });
        const order = db.get(match[1].toUpperCase());
        if (!order) return send(res, 404, { error: 'No order found for that reference.' });
        return send(res, 200, { order: publicOrder(order) });
      }

      if (m === 'GET' && path === '/api/admin/orders') {
        if (!isAdmin(req)) return send(res, 401);
        return send(res, 200, { orders: db.recent(100, url.searchParams.get('status') || undefined) });
      }

      // Only for orders the supplier clearly refused. Never for 'review' orders.
      if (m === 'POST' && (match = path.match(/^\/api\/admin\/orders\/([A-Za-z0-9-]+)\/retry$/))) {
        if (!isAdmin(req)) return send(res, 401);
        if (!db.requeue(match[1].toUpperCase())) return send(res, 409, { error: 'Only failed orders can be retried.' });
        deliver(match[1].toUpperCase());
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: 'Not found.' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 413 ? 'Request too large.' : 'Something went wrong.' });
    }
  };
}

module.exports = { createApp, newReference };

if (require.main === module) {
  config.assert();
  const db = dbModule.open(config.dbPath);
  http.createServer(createApp({ db })).listen(config.port, () => {
    console.log(`Kendor backend on port ${config.port} (payments: ${config.paymentMode}, supplier: ${config.supplierMode})`);
  });
}
