CREATE TABLE IF NOT EXISTS shopping_lists (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS list_shares (
  list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (list_id, email)
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

DO $$
BEGIN
  IF to_regclass('public.households') IS NOT NULL
     AND to_regclass('public.household_memberships') IS NOT NULL THEN
    ALTER TABLE shopping_lists ADD COLUMN IF NOT EXISTS legacy_household_id INTEGER;

    INSERT INTO shopping_lists (owner_id, name, created_at, legacy_household_id)
    SELECT owner.user_id, households.name, households.created_at, households.id
    FROM households
    JOIN LATERAL (
      SELECT household_memberships.user_id
      FROM household_memberships
      WHERE household_memberships.household_id = households.id
      ORDER BY CASE WHEN household_memberships.role = 'owner' THEN 0 ELSE 1 END,
               household_memberships.created_at,
               household_memberships.user_id
      LIMIT 1
    ) owner ON TRUE
    WHERE NOT EXISTS (
      SELECT 1
      FROM shopping_lists
      WHERE shopping_lists.legacy_household_id = households.id
    );

    UPDATE shopping_lists
    SET legacy_household_id = households.id
    FROM households
    WHERE shopping_lists.legacy_household_id IS NULL
      AND shopping_lists.name = households.name
      AND shopping_lists.created_at = households.created_at;

    INSERT INTO list_shares (list_id, email, created_at)
    SELECT shopping_lists.id, users.email, household_memberships.created_at
    FROM households
    JOIN shopping_lists
      ON shopping_lists.legacy_household_id = households.id
    JOIN household_memberships
      ON household_memberships.household_id = households.id
     AND household_memberships.user_id <> shopping_lists.owner_id
    JOIN users ON users.id = household_memberships.user_id
    ON CONFLICT (list_id, email) DO NOTHING;
  END IF;

  IF to_regclass('public.items') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'items'
        AND column_name = 'list_id'
    ) THEN
      ALTER TABLE items ADD COLUMN list_id INTEGER REFERENCES shopping_lists(id) ON DELETE CASCADE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'items'
        AND column_name = 'household_id'
    ) AND to_regclass('public.households') IS NOT NULL THEN
      UPDATE items
      SET list_id = shopping_lists.id
      FROM households
      JOIN shopping_lists
        ON shopping_lists.legacy_household_id = households.id
      WHERE items.household_id = households.id
        AND items.list_id IS NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM items WHERE list_id IS NULL) THEN
      INSERT INTO shopping_lists (owner_id, name, created_at)
      SELECT users.id, 'Groceries', NOW()
      FROM users
      WHERE NOT EXISTS (
        SELECT 1 FROM shopping_lists WHERE shopping_lists.owner_id = users.id
      );

      UPDATE items
      SET list_id = shopping_lists.id
      FROM shopping_lists
      WHERE shopping_lists.owner_id = (
        SELECT users.id FROM users ORDER BY users.id LIMIT 1
      )
        AND items.list_id IS NULL;
    END IF;

    ALTER TABLE items ALTER COLUMN list_id SET NOT NULL;
  ELSE
    CREATE TABLE items (
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
  END IF;
END $$;

INSERT INTO shopping_lists (owner_id, name, created_at)
SELECT users.id, 'Groceries', NOW()
FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM shopping_lists WHERE shopping_lists.owner_id = users.id
);
