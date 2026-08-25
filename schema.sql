CREATE TABLE IF NOT EXISTS users (
  chat_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  chat_id TEXT PRIMARY KEY,
  leaves REAL NOT NULL,
  total_earned REAL NOT NULL,
  income_per_sec REAL NOT NULL,
  trees TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
