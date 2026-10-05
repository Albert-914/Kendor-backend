// All settings come from environment variables. See .env.example.
const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || './kendor.db',

  // 'mock' pretends to take payment. 'live' talks to Paystack.
  paymentMode: env.PAYMENT_MODE || 'mock',
  // 'mock' pretends to deliver. 'http' calls your supplier's API (see supplier.js).
  supplierMode: env.SUPPLIER_MODE || 'mock',

  paystackSecret: env.PAYSTACK_SECRET_KEY || (env.PAYMENT_MODE === 'live' ? '' : 'test_secret'),
  // Where Paystack sends the customer after paying (your Kendor page).
  appUrl: env.APP_URL || 'http://localhost:3000',
  // Paystack needs an email per payment. Customers only give a phone number,
  // so we build one from the phone. Set this to a domain you own.
  customerEmailDomain: env.CUSTOMER_EMAIL_DOMAIN || 'kendor.example',

  supplierApiUrl: env.SUPPLIER_API_URL || '',
  supplierApiKey: env.SUPPLIER_API_KEY || '',

  adminToken: env.ADMIN_TOKEN || '',
  allowedOrigin: env.ALLOWED_ORIGIN || '*',
};

config.assert = function assert() {
  const problems = [];
  if (config.paymentMode === 'live' && !config.paystackSecret) problems.push('PAYSTACK_SECRET_KEY is required when PAYMENT_MODE=live');
  if (config.supplierMode === 'http' && (!config.supplierApiUrl || !config.supplierApiKey)) problems.push('SUPPLIER_API_URL and SUPPLIER_API_KEY are required when SUPPLIER_MODE=http');
  if (config.paymentMode === 'live' && !config.adminToken) problems.push('ADMIN_TOKEN is required when PAYMENT_MODE=live');
  if (problems.length) throw new Error('Config problems:\n- ' + problems.join('\n- '));
};

module.exports = config;
