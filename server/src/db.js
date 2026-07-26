import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

// Pre-launch schema change (device-based identity, no email sign-in): drop the old
// email-required tables so the new schema.sql can recreate them cleanly. Safe because
// no paying customers exist on the old schema yet.
function needsMigration() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  return Boolean(row && /email TEXT UNIQUE NOT NULL/.test(row.sql));
}

if (needsMigration()) {
  db.exec(`
    DROP TABLE IF EXISTS revisions;
    DROP TABLE IF EXISTS generations;
    DROP TABLE IF EXISTS resumes;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS login_sessions;
  `);
}

const schema = readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
db.exec(schema);

// Additive migrations for databases created before these columns existed.
// SQLite has no ADD COLUMN IF NOT EXISTS, so ignore the "duplicate column" error.
for (const statement of [
  'ALTER TABLE generations ADD COLUMN job_text TEXT',
  'ALTER TABLE generations ADD COLUMN match_before INTEGER',
  'ALTER TABLE generations ADD COLUMN match_after INTEGER',
  "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  "ALTER TABLE discounts ADD COLUMN value_type TEXT NOT NULL DEFAULT 'percent'",
  'ALTER TABLE discounts ADD COLUMN amount_off REAL',
  'ALTER TABLE plan_settings ADD COLUMN price_usd_yearly REAL',
  'ALTER TABLE plan_settings ADD COLUMN stripe_price_id_yearly TEXT'
]) {
  try {
    db.exec(statement);
  } catch (_alreadyExists) {
    // Column is already there - nothing to do.
  }
}

// Seed the three plans once. Real Product/Price IDs from the live ResumePilot Stripe
// products (created manually) are the defaults so checkout works immediately; the
// admin panel can change price/quota from here on and this seed never runs again for
// a plan once its row exists (ON CONFLICT DO NOTHING).
const now = new Date().toISOString();
// price_usd_yearly seeds at ~2 months free vs. monthly x12 (a common, easy-to-explain
// yearly discount); stripe_price_id_yearly starts null and is minted on first admin save
// in the Plans tab (a live Stripe API call, which this seed step can't make).
const PLAN_SEEDS = [
  { plan: 'free', price_usd: 0, price_usd_yearly: 0, generation_limit: 5, stripe_product_id: null, stripe_price_id: null, stripe_price_id_yearly: null },
  { plan: 'pro', price_usd: 19, price_usd_yearly: 190, generation_limit: 100, stripe_product_id: 'prod_UxC778S14ApA5D', stripe_price_id: 'price_1TxHjeDiLpEG7BMio9JS9k8Y', stripe_price_id_yearly: null },
  { plan: 'elite', price_usd: 29, price_usd_yearly: 290, generation_limit: 300, stripe_product_id: 'prod_UxC8XhbCXSP6JT', stripe_price_id: 'price_1TxHkeDiLpEG7BMi51A6xYFC', stripe_price_id_yearly: null }
];
const seedPlan = db.prepare(
  `INSERT INTO plan_settings (plan, price_usd, price_usd_yearly, generation_limit, stripe_product_id, stripe_price_id, stripe_price_id_yearly, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan) DO NOTHING`
);
for (const seed of PLAN_SEEDS) {
  seedPlan.run(seed.plan, seed.price_usd, seed.price_usd_yearly, seed.generation_limit, seed.stripe_product_id, seed.stripe_price_id, seed.stripe_price_id_yearly, now);
}
