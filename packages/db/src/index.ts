import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";

export { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
export * from "./schema";
export { schema };

export type Database = ReturnType<typeof createDb>["db"];

interface CreateDbOptions {
  connectionString: string;
  /** PEM of the Coolify CA. When set, connections use TLS with full certificate verification. */
  caCert?: string;
  max?: number;
}

/**
 * One pool per process. On Vercel, pass the pool to `attachDatabasePool` from `@vercel/functions`
 * so idle clients are released before the function suspends.
 */
export function createDb({ connectionString, caCert, max = 10 }: CreateDbOptions) {
  const pool = new pg.Pool({
    connectionString,
    max,
    ssl: caCert ? { ca: caCert, rejectUnauthorized: true } : undefined,
  });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

/**
 * Apply pending SQL migrations. `migrationsFolder` is passed explicitly (an absolute path in the
 * worker image) because paths relative to this source file break once the worker is bundled.
 */
export async function runMigrations(db: Database, migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
}
