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
  'ALTER TABLE plan_settings ADD COLUMN stripe_price_id_yearly TEXT',
  'ALTER TABLE discounts ADD COLUMN stripe_coupon_id_yearly TEXT',
  'ALTER TABLE users ADD COLUMN credits_used INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE plan_settings ADD COLUMN credits_monthly INTEGER',
  'ALTER TABLE plan_settings ADD COLUMN match_limit INTEGER',
  'ALTER TABLE users ADD COLUMN match_checks_used INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN match_checks_today INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN match_checks_day TEXT',
  'ALTER TABLE resumes ADD COLUMN original_name TEXT',
  'ALTER TABLE resumes ADD COLUMN original_mime TEXT',
  'ALTER TABLE resumes ADD COLUMN original_data TEXT'
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
// credits_monthly is the paid plans' monthly credit pool (null for free, which stays
// quota-based via generation_limit).
// match_limit caps check-match uses: per 30-day period on free, per UTC day on paid.
const PLAN_SEEDS = [
  { plan: 'free', price_usd: 0, price_usd_yearly: 0, generation_limit: 5, credits_monthly: null, match_limit: 5, stripe_product_id: null, stripe_price_id: null, stripe_price_id_yearly: null },
  { plan: 'pro', price_usd: 19, price_usd_yearly: 190, generation_limit: 100, credits_monthly: 200, match_limit: 20, stripe_product_id: 'prod_UxC778S14ApA5D', stripe_price_id: 'price_1TxHjeDiLpEG7BMio9JS9k8Y', stripe_price_id_yearly: null },
  { plan: 'elite', price_usd: 29, price_usd_yearly: 290, generation_limit: 300, credits_monthly: 500, match_limit: 20, stripe_product_id: 'prod_UxC8XhbCXSP6JT', stripe_price_id: 'price_1TxHkeDiLpEG7BMi51A6xYFC', stripe_price_id_yearly: null }
];
const seedPlan = db.prepare(
  `INSERT INTO plan_settings (plan, price_usd, price_usd_yearly, generation_limit, credits_monthly, match_limit, stripe_product_id, stripe_price_id, stripe_price_id_yearly, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan) DO NOTHING`
);
for (const seed of PLAN_SEEDS) {
  seedPlan.run(seed.plan, seed.price_usd, seed.price_usd_yearly, seed.generation_limit, seed.credits_monthly, seed.match_limit, seed.stripe_product_id, seed.stripe_price_id, seed.stripe_price_id_yearly, now);
}

// One-time backfill for databases seeded before credits_monthly existed: the plan
// rows already exist there, so the ON CONFLICT seed above never fills the column in.
db.exec(`
  UPDATE plan_settings SET credits_monthly = 200 WHERE plan = 'pro' AND credits_monthly IS NULL;
  UPDATE plan_settings SET credits_monthly = 500 WHERE plan = 'elite' AND credits_monthly IS NULL;
`);

// Same one-time backfill for match_limit: 5 per period on free, 20 per day on paid.
db.exec(`
  UPDATE plan_settings SET match_limit = 5 WHERE plan = 'free' AND match_limit IS NULL;
  UPDATE plan_settings SET match_limit = 20 WHERE plan = 'pro' AND match_limit IS NULL;
  UPDATE plan_settings SET match_limit = 20 WHERE plan = 'elite' AND match_limit IS NULL;
`);

// Seed the per-use credit prices for paid-plan features. Admin-editable afterwards
// (PUT /admin/credit-costs), so this seed never overwrites an existing row.
// check-match has no row on purpose: it is always free and not configurable.
const COST_SEEDS = [
  ['light', 1],
  ['medium', 2],
  ['max', 3],
  ['ultra', 5],
  ['revise', 1],
  ['boost', 2]
];
const seedCost = db.prepare(
  'INSERT INTO credit_costs (feature, credits) VALUES (?, ?) ON CONFLICT(feature) DO NOTHING'
);
for (const [feature, credits] of COST_SEEDS) {
  seedCost.run(feature, credits);
}
