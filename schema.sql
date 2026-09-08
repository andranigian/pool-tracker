-- schema.sql — Pool Tracker (Cloudflare D1)
--
-- Standalone confidence-pool site: no sign-in, no shared account system.
-- Anyone can make picks under a nickname + PIN they choose themselves (the
-- PIN just proves "this is still the same person" on a later visit -- it's
-- not an account system, there's no email, no password reset, nothing to
-- forget except the PIN itself). One admin, gated by a single shared
-- password (see functions/api/_lib.js), uploads/edits the week's games.
--
-- Run once to set up: npx wrangler d1 execute pool-tracker --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS weeks (
  id           TEXT PRIMARY KEY,               -- e.g. '2026-w1'
  season       INTEGER NOT NULL,
  week_number  INTEGER NOT NULL,
  label        TEXT,                            -- e.g. 'College Football'
  deadline     TEXT NOT NULL,                    -- ISO 8601 UTC
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS games (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id      TEXT NOT NULL REFERENCES weeks(id),
  sheet_number INTEGER NOT NULL,                -- the pair's number on the sheet
  favorite     TEXT NOT NULL,
  underdog     TEXT NOT NULL,
  spread       REAL NOT NULL,                    -- points the underdog gets
  status       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | in_progress | final | cancelled
  winner_side  TEXT,                              -- 'favorite' | 'underdog' | 'push' | NULL until final
  UNIQUE(week_id, sheet_number)
);
CREATE INDEX IF NOT EXISTS idx_games_week ON games(week_id);

-- One row per nickname, ever (not per week) -- the same nickname carries
-- across weeks so season totals accumulate. `id` is the normalized
-- (trimmed, lowercased) lookup key so "Paul" and "paul" collide instead of
-- silently splitting one person's season total into two rows; `display_name`
-- keeps whatever casing they actually typed, for showing in standings.
CREATE TABLE IF NOT EXISTS players (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  pin_hash     TEXT NOT NULL,                    -- SHA-256 of the PIN, salted with this player's id
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS picks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    TEXT NOT NULL REFERENCES players(id),
  week_id      TEXT NOT NULL REFERENCES weeks(id),
  game_id      INTEGER NOT NULL REFERENCES games(id),
  side         TEXT NOT NULL,                    -- 'favorite' | 'underdog'
  points       INTEGER NOT NULL,                 -- confidence value assigned, 1-N
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(player_id, week_id, game_id),            -- can't pick the same game twice
  UNIQUE(player_id, week_id, points)              -- can't reuse the same point value twice in a week
);
CREATE INDEX IF NOT EXISTS idx_picks_week   ON picks(week_id);
CREATE INDEX IF NOT EXISTS idx_picks_player ON picks(player_id);

-- Everyone's picks entered from the paper/roster sheet uploaded in
-- /admin-pool (see admin/parse-roster.js, admin/save-roster.js), for
-- players who don't use the self-serve picks page above. Deliberately
-- separate from players/picks -- no PIN, no player row, just the
-- nickname text as it appears on the sheet -- so this can never collide
-- with someone using the self-serve flow under a similar-looking name.
-- See sheet-standings.js for how these get scored and shown, on their
-- own standings page, kept apart from the self-serve leaderboard.
CREATE TABLE IF NOT EXISTS roster_picks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id    TEXT NOT NULL REFERENCES weeks(id),
  nickname   TEXT NOT NULL,
  game_id    INTEGER NOT NULL REFERENCES games(id),
  side       TEXT NOT NULL,                    -- 'favorite' | 'underdog'
  points     INTEGER NOT NULL,                 -- confidence value, 1-10 (the sheet's own fixed scale)
  UNIQUE(week_id, nickname, game_id),           -- can't pick the same game twice
  UNIQUE(week_id, nickname, points)             -- can't reuse the same point value twice in a week
);
CREATE INDEX IF NOT EXISTS idx_roster_picks_week ON roster_picks(week_id);
