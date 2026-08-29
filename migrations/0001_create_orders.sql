CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAILED')),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  customer_address TEXT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal REAL NOT NULL,
  delivery_fee REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  invoice_id TEXT,
  payment_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_invoice_id ON orders(invoice_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_id ON orders(payment_id);
