import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Add a `DB` entry under d1_databases in vite.config.ts (and in your Cloudflare deployment) before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}
