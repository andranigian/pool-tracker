// functions/api/admin/parse-sheet.js — POST /api/admin/parse-sheet
// Admin-only: uploads a weekly confidence-pool .xlsx, parses it into a
// week + games structure for review. Does NOT write to the database --
// admin-pool.html shows the parsed result for review/edits, then confirms
// via /api/admin/save-week.
//
// Ported from the hyedad version of this pool (league-tracker's
// pool-parse.js) -- same general sheet shape, same parsing rules, just
// gated by this site's own admin cookie instead of a shared hyedad login.
//
// Two kinds of row, both favorite-number/favorite-name in col 0/1 then
// underdog-number/underdog-name somewhere later in the same row (found by
// SCANNING, not a fixed column -- the exact spacing shifts week to week
// depending on how wide the sheet's own side leaderboard is that week):
//   - market='spread': a normal favorite-vs-underdog game. The spread
//     ("+2") is scanned for after the underdog's name.
//   - market='total': the "team" names are literally UNDER/OVER -- an
//     over/under prop on the total combined score of the MOST RECENT
//     market='spread' row above it (that's how the sheet lays them out,
//     immediately under their game). Its favorite/underdog are set to
//     that real game's actual teams -- NOT the strings "Over"/"Under" --
//     so ESPN score lookup (by team name, in refresh.js's caller) works
//     identically for both markets. The two lines the sheet prints
//     (e.g. "UNDER 44" / "OVER 46", always exactly 2 apart in practice)
//     sit right after each label, not after the underdog like a normal
//     spread, and as plain numbers rather than "+N" text -- spread is
//     stored as their midpoint (45); see refresh.js for how a push
//     exactly on that midpoint is scored the same way a spread push is.
//
// Some numbers carry a letter prefix ("T1.", "T2." for early Wed/Thu
// games; "M1.", "M2." for Monday's) instead of a plain digit -- still
// real rows, just numbered in their own separate sequence, so their
// internal sheetNumber gets a large per-letter offset to avoid colliding
// with the plain-numbered games (see sheetNumberFor()).
//
// A day-of-week header ("Saturday, September 5th") appears in its own row
// and applies to every game row until the next one. The week/season are
// read from the uploaded filename's "25W1T"/"26W1T"-style convention
// (YYWN -> season 20YY, week N).
import { json, requireAdmin } from "../_lib.js";
import * as XLSX from "../../_vendor/xlsx.bundle.mjs"; // pre-bundled locally: no build step runs on this Pages project, so a bare "xlsx" package specifier can never resolve

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, generous for a text-only workbook

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const denied = await requireAdmin(env, request);
    if (denied) return denied;

    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return json({ error: "expected a multipart/form-data upload with a 'sheet' field" }, 400);
    }

    const file = form.get("sheet");
    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ error: "no file found in the 'sheet' field" }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return json({ error: "file is too large (max 10MB)" }, 400);
    }

    let rows;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    } catch (e) {
      console.error("admin/parse-sheet: xlsx read failed", String((e && e.message) || e));
      return json({ error: "couldn't read that file — is it a valid .xlsx?" }, 400);
    }

    const parsed = parsePoolSheet(rows);
    const fromName = parseWeekFromFilename(file.name || "");

    return json({
      ok: true,
      weekNumberGuess: fromName.weekNumber ?? parsed.weekNumber,
      seasonGuess: fromName.season,
      games: parsed.games
    });
  } catch (e) {
    console.error("admin/parse-sheet POST: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}

const DAY_RE = /^(Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday),/;
const GAME_NUM_RE = /^([A-Za-z]{0,2})(\d{1,3})\.$/; // "1." | "T1." | "M12."
const NUMERIC_RE = /^\+?\d+(\.\d+)?$/;

// Accepts either a "+2"-style text cell or a bare numeric cell (the total
// lines on a market='total' row are plain numbers, not "+N" text).
function numericValue(c) {
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (typeof c === "string" && NUMERIC_RE.test(c.trim())) return parseFloat(c.replace("+", ""));
  return null;
}

// Plain numbers keep their natural sheetNumber; a lettered prefix ("T","M")
// gets its own block, offset well clear of the plain range, so "T1."
// can't collide with plain "1." as a week's games grow.
function sheetNumberFor(prefix, num) {
  const base = Math.ceil(num / 2);
  if (!prefix) return base;
  return (prefix.toUpperCase().charCodeAt(0) - 64) * 1000 + base;
}

function parsePoolSheet(rows) {
  let weekNumber = null;
  let currentDay = null;
  let lastSpreadTeams = null; // { favorite, underdog } of the most recent market='spread' row

  const games = [];

  for (const row of rows) {
    if (!Array.isArray(row)) continue;

    if (weekNumber === null) {
      for (const cell of row) {
        if (typeof cell === "string") {
          const m = cell.match(/WEEK\s+(\d+)\s+of\s+\d+/i);
          if (m) { weekNumber = parseInt(m[1], 10); break; }
        }
      }
    }

    const dayCell = row.find(c => typeof c === "string" && DAY_RE.test(c.trim()));
    if (dayCell) currentDay = dayCell.trim();

    const favNumRaw = row[0], favName = row[1];
    if (typeof favNumRaw !== "string" || typeof favName !== "string") continue;
    const favM = favNumRaw.trim().match(GAME_NUM_RE);
    if (!favM) continue;
    const favPrefix = favM[1] || "";
    const favNum = parseInt(favM[2], 10);

    // The underdog's own number/name pair is somewhere later in the same
    // row -- find it by scanning instead of assuming a fixed column, since
    // the gap varies week to week (see header comment).
    let dogCol = -1;
    for (let i = 2; i < row.length; i++) {
      const c = row[i];
      if (typeof c === "string" && GAME_NUM_RE.test(c.trim())) { dogCol = i; break; }
    }
    if (dogCol === -1) continue;
    const dogM = row[dogCol].trim().match(GAME_NUM_RE);
    const dogPrefix = dogM[1] || "";
    const dogNum = parseInt(dogM[2], 10);
    const dogName = row[dogCol + 1];
    if (typeof dogName !== "string") continue;
    if (dogPrefix !== favPrefix || dogNum !== favNum + 1) continue; // pairing looks off -- admin re-enters by hand

    const isTotal = /^(UNDER|OVER)$/i.test(favName.trim()) && /^(UNDER|OVER)$/i.test(dogName.trim());

    let market, favorite, underdog, spread;
    if (isTotal) {
      market = "total";
      if (!lastSpreadTeams) continue; // no real matchup above it to attribute this to
      favorite = lastSpreadTeams.favorite;
      underdog = lastSpreadTeams.underdog;

      // The under/over lines sit right after each label (favName+2,
      // dogName+2), not after the underdog like a normal spread, and are
      // plain numbers rather than "+N" text.
      let underLine = null, overLine = null;
      for (let i = 2; i < dogCol; i++) { const v = numericValue(row[i]); if (v != null) { underLine = v; break; } }
      for (let i = dogCol + 2; i < row.length; i++) {
        const c = row[i];
        if (c == null) continue;
        overLine = numericValue(c);
        break;
      }
      spread = underLine != null && overLine != null ? (underLine + overLine) / 2
        : overLine != null ? overLine - 1
        : underLine != null ? underLine + 1
        : null; // admin fills this in by hand in the review table
    } else {
      market = "spread";
      favorite = favName.trim();
      underdog = dogName.trim();
      lastSpreadTeams = { favorite, underdog };

      // The spread is somewhere after the underdog's name -- same
      // "scan forward" reasoning as above. Stop at the first non-empty
      // cell so this can't skip past unrelated columns (like a side
      // leaderboard) and pick up some other section's number instead.
      spread = null;
      for (let i = dogCol + 2; i < row.length; i++) {
        const c = row[i];
        if (c == null) continue;
        spread = numericValue(c);
        break;
      }
    }

    games.push({
      sheetNumber: sheetNumberFor(favPrefix, favNum),
      // The actual number printed on the sheet for this game's first row
      // (e.g. "5" or "T1") -- sheetNumber above is an internal ordering
      // key only, and for lettered games it's a different number than
      // what's printed, so a player can't use it to find the game on
      // their own paper sheet. This is what gets shown to them instead.
      sheetLabel: favPrefix + favNum,
      market,
      favorite,
      underdog,
      spread,
      dayLabel: currentDay
    });
  }

  return { weekNumber, games };
}

// "25W1T.xlsx" / "26W1T.pdf" -> { season: 2025, weekNumber: 1 }
function parseWeekFromFilename(name) {
  const m = name.match(/(\d{2})W(\d+)/i);
  if (!m) return { season: null, weekNumber: null };
  return { season: 2000 + parseInt(m[1], 10), weekNumber: parseInt(m[2], 10) };
}
