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

CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id);
CREATE INDEX IF NOT EXISTS idx_revisions_generation ON revisions(generation_id);
