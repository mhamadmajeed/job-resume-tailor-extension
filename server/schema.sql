-- credits_used tracks the paid plans' per-period credit spend (see credit_costs).
-- It resets to 0 wherever generations_used resets: on a 30-day period roll and on a
-- paid checkout webhook. Free users never spend credits; they are governed by
-- generations_used against plan_settings.generation_limit instead.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  generations_used INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  -- match_checks_used is the FREE plan's check-match counter for the current 30-day
  -- period; it resets alongside generations_used. match_checks_today/match_checks_day
  -- are the paid plans' counter for the UTC calendar day stored in match_checks_day
  -- ('YYYY-MM-DD'); a stale day means the count is effectively 0.
  match_checks_used INTEGER NOT NULL DEFAULT 0,
  match_checks_today INTEGER NOT NULL DEFAULT 0,
  match_checks_day TEXT NULL,
  period_start TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resumes (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  filename TEXT,
  resume_text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  job_title TEXT,
  job_url TEXT,
  job_text TEXT,
  current_text TEXT NOT NULL,
  match_before INTEGER,
  match_after INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_checks (
  user_id TEXT NOT NULL REFERENCES users(id),
  job_hash TEXT NOT NULL,
  score INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (user_id, job_hash)
);

-- A real, cross-device identity (Google Sign-In). "users.id" (the owner key for
-- resumes/generations/quota) is either a device_id (anonymous, extension-only) or an
-- account_id once a device has been linked to one - see resolveOwnerId in index.js.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT,
  name TEXT,
  picture_url TEXT,
  created_at TEXT NOT NULL
);

-- Maps an extension install (device_id) to the account it has been linked to, if any.
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  linked_at TEXT
);

-- Short-lived device-code-style handshake so the extension can link to an account
-- without ever handling the OAuth redirect itself.
CREATE TABLE IF NOT EXISTS device_links (
  token TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  account_email TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- CSRF state for the Google OAuth roundtrip; also carries where to redirect back to
-- and an optional device_links token, since Google only echoes back one opaque string.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  link_token TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id);
CREATE INDEX IF NOT EXISTS idx_revisions_generation ON revisions(generation_id);

-- Admin panel: roles for people managing the product (owner/moderator/writer).
-- account_id starts NULL when an admin is invited by email before they've ever
-- signed in; it gets bound to the matching account on their first Google sign-in.
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  account_id TEXT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- In-app notifications sent to an account by an admin, individually or via broadcast.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT,
  body TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT NULL
);

-- Public blog, written and published from the admin panel.
CREATE TABLE IF NOT EXISTS blog_posts (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  title TEXT,
  excerpt TEXT,
  content TEXT,
  status TEXT DEFAULT 'draft',
  author_admin_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  published_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_admins_account ON admins(account_id);
CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);

-- Pricing discounts, managed by the owner in the admin panel. 'standard' is an
-- always-on sale while active; 'urgency' is a first-visit evergreen offer that opens
-- a personal countdown window per visitor - see visitor_offers and the urgency
-- lifecycle in index.js.
CREATE TABLE IF NOT EXISTS discounts (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'percent',
  percent_off INTEGER NOT NULL,
  amount_off REAL,
  applies_to TEXT NOT NULL DEFAULT 'both',
  active INTEGER NOT NULL DEFAULT 0,
  -- amount_off is always PER MONTH ($10 off means $120 off a yearly invoice), so
  -- amount discounts need a different Stripe coupon per billing cycle. Percent
  -- discounts scale naturally but get per-cycle coupons too, for uniformity.
  stripe_coupon_id TEXT NULL,
  stripe_coupon_id_yearly TEXT NULL,
  created_at TEXT
);

-- One row per (visitor, discount): the visitor's personal urgency offer window and
-- the cooldown that follows it once the window expires.
CREATE TABLE IF NOT EXISTS visitor_offers (
  visitor_id TEXT NOT NULL,
  discount_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (visitor_id, discount_id)
);

CREATE INDEX IF NOT EXISTS idx_discounts_type_active ON discounts(type, active);
CREATE INDEX IF NOT EXISTS idx_visitor_offers_visitor ON visitor_offers(visitor_id);

-- Admin-editable plan configuration: price and monthly generation quota per plan.
-- price_usd is 0 for 'free' (it has no Stripe price). Stripe prices are immutable
-- once created, so changing price_usd for pro/elite mints a NEW Stripe price and
-- swaps stripe_price_id to it - existing subscribers keep their original price
-- until they resubscribe, which is intentional (no surprise price hikes).
-- price_usd/stripe_price_id are the monthly price; price_usd_yearly/stripe_price_id_yearly
-- are a separate, admin-set yearly price (usually cheaper than price_usd x 12), not a
-- derived discount. The yearly Stripe price is minted lazily the first time an admin
-- sets/changes price_usd_yearly - see createPlanPrice in stripe.js.
-- credits_monthly is the paid plans' monthly credit pool (admin-editable): NULL for
-- 'free' (the free plan is quota-based, not credit-based), 200 for 'pro', 500 for
-- 'elite' by default. Monthly and yearly billing grant the same monthly pool.
-- generation_limit still governs the FREE plan's tailored resumes per 30-day period.
-- match_limit caps check-match uses: per 30-day period on 'free', per UTC calendar
-- day on 'pro'/'elite'. Admin-editable in the Plans tab; check-match never costs credits.
CREATE TABLE IF NOT EXISTS plan_settings (
  plan TEXT PRIMARY KEY,
  price_usd REAL NOT NULL DEFAULT 0,
  price_usd_yearly REAL,
  generation_limit INTEGER NOT NULL,
  credits_monthly INTEGER,
  match_limit INTEGER,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  stripe_price_id_yearly TEXT,
  updated_at TEXT
);

-- Per-use credit prices for the paid plans (admin-editable). Every feature use
-- deducts its row's credits from the user's monthly pool: the four generation
-- intensities, AI refine (revise), and boost. There is intentionally NO row for
-- check-match: it is always free for every plan and not configurable.
CREATE TABLE IF NOT EXISTS credit_costs (
  feature TEXT PRIMARY KEY,
  credits INTEGER NOT NULL
);
