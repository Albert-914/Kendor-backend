// Paystack: starts a payment and checks that webhooks really came from Paystack.
const crypto = require('crypto');
const config = require('./config');

const PAYSTACK = 'https://api.paystack.co';

async function paystack(path, options = {}) {
  const res = await fetch(PAYSTACK + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.paystackSecret}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) {
    throw new Error(`Paystack ${res.status}: ${body.message || 'request failed'}`);
  }
  return body.data;
}

// Returns a Paystack checkout link. The customer pays there with MoMo or card.
async function initialize({ email, amountPesewas, reference }) {
  if (config.paymentMode === 'mock') {
    return { authorizationUrl: `${config.appUrl}/mock-pay?reference=${reference}`, reference };
  }
  const data = await paystack('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email,
      amount: amountPesewas, // Paystack counts in pesewas
      currency: 'GHS',
      reference,
      channels: ['mobile_money', 'card'],
      callback_url: `${config.appUrl}/?reference=${reference}`,
    }),
  });
  return { authorizationUrl: data.authorization_url, reference: data.reference };
}

// Second check, straight from Paystack, that the payment really succeeded.
async function verify(reference) {
  if (config.paymentMode === 'mock') return null;
  return paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
}

// Paystack signs every webhook with HMAC-SHA512 of the raw body using your secret key.
function sign(rawBody, secret = config.paystackSecret) {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

function validSignature(rawBody, header) {
  if (!header) return false;
  const expected = Buffer.from(sign(rawBody), 'hex');
  let given;
  try { given = Buffer.from(String(header), 'hex'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { initialize, verify, sign, validSignature };
