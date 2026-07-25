import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Queryable = {
  query<Result = unknown>(text: string, values?: unknown[]): Promise<{ rows: Result[] }>;
};

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const HOUSEHOLDS_TO_LISTS_MIGRATION = "003_migrate_households_to_lists.sql";

async function hasCurrentListSchema(db: Queryable) {
  try {
    await db.query("SELECT shopping_lists.id, shopping_lists.owner_id FROM shopping_lists LIMIT 0");
    await db.query("SELECT list_shares.list_id FROM list_shares LIMIT 0");
    await db.query("SELECT items.list_id FROM items LIMIT 0");
    await db.query("SELECT user_item_history.user_id FROM user_item_history LIMIT 0");
    await db.query("SELECT list_item_history.list_id FROM list_item_history LIMIT 0");
    return true;
  } catch {
    return false;
  }
}

export async function runMigrations(db: Queryable) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationFiles = (await readdir(MIGRATIONS_DIR))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of migrationFiles) {
    const isHouseholdsMigration = filename === HOUSEHOLDS_TO_LISTS_MIGRATION;

    if (isHouseholdsMigration && (await hasCurrentListSchema(db))) {
      const existing = await db.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [filename],
      );
      if (existing.rows.length === 0) {
        await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [filename]);
      }
      continue;
    }

    const existing = await db.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = $1",
      [filename],
    );
    // Foundational schema migrations (001, 002) are always applied (CREATE IF NOT EXISTS
    // makes them cheap + defensive against incomplete history or dropped tables in prod).
    // Data-only migrations like 003 are skipped when the current schema is detected.
    const isFoundation = filename === "001_initial.sql" || filename === "002_create_default_shares.sql";
    if (existing.rows.length > 0 && !isFoundation) {
      continue;
    }

    const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    await db.query("BEGIN");
    try {
      await db.query(sql);
      if (existing.rows.length === 0) {
        await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [filename]);
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
}
