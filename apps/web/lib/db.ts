import { createDb } from "@teire/db";
import { attachDatabasePool } from "@vercel/functions";

/**
 * One pool per function instance, as the least-privilege `teire_web` role over TLS (verify-full
 * against the Coolify CA). `attachDatabasePool` releases idle clients before the function suspends.
 */
let instance: ReturnType<typeof createDb> | null = null;

export function database() {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    const caCert = process.env.DATABASE_CA_CERT;
    if (!connectionString || !caCert) throw new Error("DATABASE_URL and DATABASE_CA_CERT must be set");
    instance = createDb({ connectionString, caCert, max: 5 });
    attachDatabasePool(instance.pool);
  }
  return instance.db;
}
