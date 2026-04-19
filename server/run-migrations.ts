import { Pool } from "pg";
import { runMigrations } from "./migrate.js";

const connectionString = process.env.DATABASE_URL ?? "postgresql://shopping:shopping@127.0.0.1:54329/shopping_list";

const pool = new Pool({ connectionString });

try {
  await runMigrations(pool);
  console.log("Migrations applied");
} finally {
  await pool.end();
}
