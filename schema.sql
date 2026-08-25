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

-- Locks each invited person to whoever referred them first. One row per
-- chat_id, written once and never updated — low, bounded volume (scales
-- with unique referrals, not with active playtime), but moved here anyway
-- so the bot doesn't need KV as a separate service at all.
CREATE TABLE IF NOT EXISTS referrals (
  chat_id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
