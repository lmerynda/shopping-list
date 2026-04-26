CREATE TABLE IF NOT EXISTS shopping_lists (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE items ADD COLUMN IF NOT EXISTS list_id INTEGER REFERENCES shopping_lists(id) ON DELETE CASCADE;

INSERT INTO shopping_lists (household_id, name, created_at)
SELECT households.id, 'Groceries', households.created_at
FROM households
LEFT JOIN shopping_lists ON shopping_lists.household_id = households.id
WHERE shopping_lists.id IS NULL;

UPDATE items
SET list_id = shopping_lists.id
FROM shopping_lists
WHERE shopping_lists.household_id = items.household_id
  AND items.list_id IS NULL;

ALTER TABLE items ALTER COLUMN list_id SET NOT NULL;
