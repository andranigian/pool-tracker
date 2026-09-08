-- migrate-week1.sql — one-time copy of Week 1's games from the hyedad
-- confidence pool into this new, standalone database. Pulled from the
-- live hyedad site on 2026-09-08; every game there still shows status
-- 'scheduled' with no winner_side, so that's exactly what's carried over
-- here too (nothing to lose). No picks/roster_picks rows are migrated --
-- the live hyedad standings endpoint is currently erroring (500) so
-- there's no way to read that data back reliably; if there turn out to be
-- real picks worth preserving, dump them separately and ask Claude to
-- turn them into inserts against this new schema (players + picks).
--
-- Run once, against the NEW database, after schema.sql:
--   npx wrangler d1 execute pool-tracker --remote --file=migrate-week1.sql

INSERT INTO weeks (id, season, week_number, label, deadline) VALUES
  ('2025-w1', 2025, 1, 'College Football', '2026-09-05T06:11:00.000Z');

INSERT INTO games (week_id, sheet_number, favorite, underdog, spread, status, winner_side) VALUES
  ('2025-w1', 1, 'U.c.l.a.', 'CALIFORNIA', 2, 'scheduled', NULL),
  ('2025-w1', 2, 'U.n.l.v.', 'HAWAI''i', 3, 'scheduled', NULL),
  ('2025-w1', 3, 'Western Kentucky', 'NEVADA', 3, 'scheduled', NULL),
  ('2025-w1', 4, 'COLORADA STATE', 'Wyoming', 4, 'scheduled', NULL),
  ('2025-w1', 5, 'JAMES MADISON', 'Liberty', 7, 'scheduled', NULL),
  ('2025-w1', 6, 'CINCINNATI', 'Boston College', 8, 'scheduled', NULL),
  ('2025-w1', 7, 'DUKE', 'Tulane', 8, 'scheduled', NULL),
  ('2025-w1', 8, 'AUBURN', 'Baylor', 8, 'scheduled', NULL),
  ('2025-w1', 9, 'L.S.U.', 'Clemson', 10, 'scheduled', NULL),
  ('2025-w1', 10, 'NEW MEXICO', 'Central Michigan', 10, 'scheduled', NULL),
  ('2025-w1', 11, 'MEMPHIS', 'Arkansas State', 12, 'scheduled', NULL),
  ('2025-w1', 12, 'Oklahoma State', 'TULSA', 13, 'scheduled', NULL),
  ('2025-w1', 13, 'NORTHWESTERN', 'South Dakota State', 13, 'scheduled', NULL),
  ('2025-w1', 14, 'SOUTH FLORIDA', 'Florida International', 15, 'scheduled', NULL),
  ('2025-w1', 15, 'PITTSBURGH', 'Miami (Oh)', 17, 'scheduled', NULL),
  ('2025-w1', 16, 'TROY', 'Sam Houston', 17, 'scheduled', NULL),
  ('2025-w1', 17, 'WEST VIRGINIA', 'Coastal Carolina', 21, 'scheduled', NULL),
  ('2025-w1', 18, 'HOUSTON', 'Oregon State', 21, 'scheduled', NULL),
  ('2025-w1', 19, 'NEBRASKA', 'Ohio', 24, 'scheduled', NULL),
  ('2025-w1', 20, 'KENTUCKY', 'Youngstown State', 24, 'scheduled', NULL),
  ('2025-w1', 21, 'PENN STATE', 'Marshall', 25, 'scheduled', NULL),
  ('2025-w1', 22, 'OREGON', 'Boise State', 25, 'scheduled', NULL),
  ('2025-w1', 23, 'ALABAMA', 'East Carolina', 28, 'scheduled', NULL),
  ('2025-w1', 24, 'MICHIGAN', 'Western Michigan', 28, 'scheduled', NULL),
  ('2025-w1', 25, 'FLORIDA', 'Florida Atlantic', 28, 'scheduled', NULL),
  ('2025-w1', 26, 'MISSISSIPPI STATE', 'Louisiana-Monroe', 30, 'scheduled', NULL),
  ('2025-w1', 27, 'IOWA STATE', 'S.w. Missouri St.', 30, 'scheduled', NULL),
  ('2025-w1', 28, 'TEXAS', 'Texas State', 31, 'scheduled', NULL),
  ('2025-w1', 29, 'IOWA', 'Northern Illinois', 32, 'scheduled', NULL),
  ('2025-w1', 30, 'NAVY', 'Towson', 32, 'scheduled', NULL),
  ('2025-w1', 31, 'ARIZONA', 'Northern Arizona', 34, 'scheduled', NULL),
  ('2025-w1', 32, 'SOUTH CAROLINA', 'Kent State', 37, 'scheduled', NULL),
  ('2025-w1', 33, 'SAN DIEGO STATE', 'Portland State', 40, 'scheduled', NULL),
  ('2025-w1', 34, 'INDIANA', 'North Texas', 41, 'scheduled', NULL),
  ('2025-w1', 35, 'TEXAS A&M', 'Missouri State', 41, 'scheduled', NULL),
  ('2025-w1', 36, 'GEORGIA', 'Tennessee State', 47, 'scheduled', NULL),
  ('2025-w1', 37, 'OHIO STATE', 'Ball State', 51, 'scheduled', NULL),
  ('2025-w1', 38, 'MISSISSIPPI', 'Louisville', 7, 'scheduled', NULL),
  ('2025-w1', 39, 'NOTRE DAME', 'Wisconsin', 21, 'scheduled', NULL),
  ('2025-w1', 40, 'WASHINGTON', 'Washington State', 24, 'scheduled', NULL),
  ('2025-w1', 41, 'S.m.u.', 'FLORIDA STATE', 3, 'scheduled', NULL);
