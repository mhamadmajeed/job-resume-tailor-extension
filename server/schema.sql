CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  generations_used INTEGER NOT NULL DEFAULT 0,
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
