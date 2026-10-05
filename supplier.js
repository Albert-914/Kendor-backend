// The supplier is whoever actually sends the data. Kendor only needs two actions:
// sendData and sendAirtime. Each returns one of:
//   { ok: true,  supplierRef }   supplier confirmed delivery
//   { ok: false, error }         supplier clearly refused (safe to retry or refund)
//   { ok: false, unknown: true } we cannot tell (timeout, bad reply). Check by hand.
//
// We always send our own order reference. Good suppliers use it to refuse a
// duplicate, which protects you if a request is repeated.
const config = require('./config');

// ---- Mock supplier: for testing without spending money -------------------------
const mock = {
  calls: [],
  async sendData(order) {
    mock.calls.push({ kind: 'data', ...order });
    return { ok: true, supplierRef: 'MOCK-' + order.reference };
  },
  async sendAirtime(order) {
    mock.calls.push({ kind: 'airtime', ...order });
    return { ok: true, supplierRef: 'MOCK-' + order.reference };
  },
};

// ---- Real supplier over HTTP ---------------------------------------------------
// TODO: change this section to match your supplier's documentation. Datapot (or any
// supplier) will tell you: the address, how to authenticate, which fields to send,
// and how a successful reply looks. Everything else in Kendor stays the same.
async function call(path, body) {
  let res;
  try {
    res = await fetch(config.supplierApiUrl.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.supplierApiKey}`, // TODO: some suppliers use x-api-key instead
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    // The request may have reached the supplier. Do not assume it failed.
    return { ok: false, unknown: true, error: 'network: ' + e.message };
  }

  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, unknown: true, error: `unreadable reply (HTTP ${res.status})` };

  // TODO: match the supplier's real success and failure replies.
  if (res.ok && (data.status === 'success' || data.success === true)) {
    return { ok: true, supplierRef: String(data.reference || data.id || '') };
  }
  if (res.status >= 400 && res.status < 500) {
    return { ok: false, error: data.message || `refused (HTTP ${res.status})` };
  }
  return { ok: false, unknown: true, error: data.message || `HTTP ${res.status}` };
}

const http = {
  sendData: (o) => call('/data', { network: o.network, size_gb: o.gb, phone: o.phone, reference: o.reference }), // TODO: path and field names
  sendAirtime: (o) => call('/airtime', { network: o.network, amount: o.amountPesewas / 100, phone: o.phone, reference: o.reference }), // TODO
};

module.exports = config.supplierMode === 'http' ? http : mock;
module.exports.mock = mock;
module.exports.http = http;
