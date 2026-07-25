CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_codes (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS shopping_lists (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

-- For upgrade paths from older schemas that may lack the owner_id column
-- (e.g. pre-003 migrations or partial applies), ensure the column exists,
-- backfill any nulls (defensive, using first user), and enforce NOT NULL.
-- This runs on every deploy because 001 is always (re)applied.
ALTER TABLE shopping_lists ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
UPDATE shopping_lists SET owner_id = (SELECT id FROM users ORDER BY id LIMIT 1) WHERE owner_id IS NULL;
ALTER TABLE shopping_lists ALTER COLUMN owner_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS list_shares (
  list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (list_id, email)
);

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  category_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_item_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS list_item_history (
  list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (list_id, normalized_name)
);

-- Clean up legacy columns from the pre-lists household schema (if present from older deploys).
-- These may have been NOT NULL, causing INSERTs without the column to fail.
-- The IF EXISTS form is safe and idempotent.
ALTER TABLE shopping_lists DROP COLUMN IF EXISTS household_id;
ALTER TABLE items DROP COLUMN IF EXISTS household_id;
