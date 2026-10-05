// Orders are stored in SQLite (built into Node, no extra install).
// Money is stored in pesewas (integers) so there are no rounding errors.
//
// Status flow:
//   pending     order created, waiting for payment
//   paid        payment confirmed, delivery not started
//   delivering  supplier is being called
//   delivered   supplier confirmed
//   failed      supplier said no (safe to retry or refund)
//   review      we do not know if the data was delivered (timeout). Check with
//               the supplier BEFORE retrying or refunding.
const { DatabaseSync } = require('node:sqlite');

function open(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      network TEXT NOT NULL,
      bundle_id TEXT,
      gb REAL,
      title TEXT NOT NULL,
      phone TEXT NOT NULL,
      amount_pesewas INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      supplier_ref TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
  `);

  const now = () => new Date().toISOString();

  return {
    insert(o) {
      db.prepare(
        `INSERT INTO orders (reference, type, network, bundle_id, gb, title, phone, amount_pesewas, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(o.reference, o.type, o.network, o.bundleId || null, o.gb || null, o.title, o.phone, o.amountPesewas, now());
    },
    get(reference) {
      return db.prepare('SELECT * FROM orders WHERE reference = ?').get(reference) || null;
    },
    byPhone(phone, limit = 5) {
      return db.prepare('SELECT * FROM orders WHERE phone = ? ORDER BY id DESC LIMIT ?').all(phone, limit);
    },
    recent(limit = 100, status) {
      if (status) return db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);
      return db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(limit);
    },
    // Each of these moves an order forward only if it is in the expected state,
    // and returns true only for the one caller that made the change. This is what
    // stops a repeated webhook from delivering the same order twice.
    markPaid(reference) {
      return db.prepare(`UPDATE orders SET status='paid', paid_at=? WHERE reference=? AND status='pending'`).run(now(), reference).changes === 1;
    },
    claimDelivery(reference) {
      return db.prepare(`UPDATE orders SET status='delivering' WHERE reference=? AND status='paid'`).run(reference).changes === 1;
    },
    markDelivered(reference, supplierRef) {
      db.prepare(`UPDATE orders SET status='delivered', supplier_ref=?, delivered_at=?, error=NULL WHERE reference=?`).run(supplierRef || null, now(), reference);
    },
    markFailed(reference, error) {
      db.prepare(`UPDATE orders SET status='failed', error=? WHERE reference=?`).run(String(error || 'unknown').slice(0, 500), reference);
    },
    markReview(reference, error) {
      db.prepare(`UPDATE orders SET status='review', error=? WHERE reference=?`).run(String(error || 'unknown').slice(0, 500), reference);
    },
    requeue(reference) {
      return db.prepare(`UPDATE orders SET status='paid', error=NULL WHERE reference=? AND status='failed'`).run(reference).changes === 1;
    },
  };
}

module.exports = { open };
