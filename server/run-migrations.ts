import { Pool } from "pg";
import { config } from "./config.js";
import { runMigrations } from "./migrate.js";

const pool = new Pool({ connectionString: config.databaseUrl });

try {
  await runMigrations(pool);
  console.log("Migrations applied");
} finally {
  await pool.end();
}
