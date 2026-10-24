BEGIN;
CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS enquiries (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT GENERATED ALWAYS AS ('VLT-' || lpad(id::text, 6, '0')) STORED UNIQUE,
  job JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'website',
  status TEXT NOT NULL DEFAULT 'needs_review',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS quotes (
  id BIGSERIAL PRIMARY KEY,
  enquiry_id BIGINT NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  quote JSONB NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','sent','accepted','superseded')),
  customer_token_hash TEXT UNIQUE,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  UNIQUE(enquiry_id, revision)
);
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  enquiry_id BIGINT NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  quote_id BIGINT REFERENCES quotes(id),
  sender TEXT NOT NULL CHECK(sender IN ('customer','owner','system')),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bookings (
  enquiry_id BIGINT PRIMARY KEY REFERENCES enquiries(id) ON DELETE CASCADE,
  quote_id BIGINT NOT NULL REFERENCES quotes(id),
  collection_date DATE NOT NULL,
  arrival_window TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  enquiry_id BIGINT NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiries_recent_idx ON enquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS quotes_enquiry_idx ON quotes(enquiry_id,revision DESC);
COMMIT;
