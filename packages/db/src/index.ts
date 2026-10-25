import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as authSchema from "./auth-schema";
import * as schema from "./schema";

export { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
export * from "./auth-schema";
export * from "./schema";
export { authSchema, schema };

export type Database = ReturnType<typeof createDb>["db"];

interface CreateDbOptions {
  /** Without `sslmode`: node-postgres lets a URL's sslmode override the `ssl` object below. */
  connectionString: string;
  /** PEM of the Coolify CA. The server accepts TLS only (`hostssl`), so this is required. */
  caCert: string;
  max?: number;
}

/** TLS settings equivalent to sslmode=verify-full: the chain must lead to the Coolify CA and the host must match. */
export function tlsOptions(caCert: string) {
  return { ca: caCert, rejectUnauthorized: true };
}

/**
 * One pool per process. On Vercel, pass the pool to `attachDatabasePool` from `@vercel/functions`
 * so idle clients are released before the function suspends.
 */
export function createDb({ connectionString, caCert, max = 10 }: CreateDbOptions) {
  const pool = new pg.Pool({ connectionString, max, ssl: tlsOptions(caCert) });
  const db = drizzle({ client: pool, schema: { ...schema, ...authSchema } });
  return { db, pool };
}

/**
 * Apply pending SQL migrations. `migrationsFolder` is passed explicitly (an absolute path in the
 * worker image) because paths relative to this source file break once the worker is bundled.
 */
export async function runMigrations(db: Database, migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
}
