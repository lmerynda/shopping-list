CREATE TABLE IF NOT EXISTS user_item_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS household_item_history (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (household_id, normalized_name)
);

INSERT INTO household_item_history (household_id, normalized_name, display_name, use_count, last_used_at)
SELECT household_id,
       normalized_name,
       MIN(name) AS display_name,
       COUNT(*) AS use_count,
       MAX(created_at) AS last_used_at
FROM items
GROUP BY household_id, normalized_name
ON CONFLICT (household_id, normalized_name) DO NOTHING;
