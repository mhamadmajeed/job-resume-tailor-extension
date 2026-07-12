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
