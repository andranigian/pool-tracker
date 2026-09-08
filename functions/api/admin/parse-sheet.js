// functions/api/admin/parse-sheet.js — POST /api/admin/parse-sheet
// Admin-only: uploads a weekly confidence-pool .xlsx, parses it into a
// week + games structure for review. Does NOT write to the database --
// admin-pool.html shows the parsed result for review/edits, then confirms
// via /api/admin/save-week.
//
// Ported from the hyedad version of this pool (league-tracker's
// pool-parse.js) -- same general sheet shape, same parsing rules, just
// gated by this site's own admin cookie instead of a shared hyedad login.
// Column shape (0-indexed, header:1 array-of-arrays):
//   col 0 = favorite's number, e.g. "1."    col 1 = favorite name
//   then, somewhere later in the same row: the underdog's own number
//   (e.g. "2."), its name in the next column, and eventually a spread
//   like "+2" -- found by SCANNING rather than fixed column indices,
//   because the exact spacing shifts week to week (the sheet's own
//   side leaderboard grows/shrinks the gap between the favorite and
//   underdog columns). Week 1's sheet had the underdog at col 8/name at
//   col 9/spread at col 15; week 2's had them at col 5/6/10 instead --
//   same layout otherwise, just narrower this week.
// Rows whose "team" name is UNDER/OVER are total-points props, not a
// favorite/underdog game, and are skipped -- this pool only supports
// picking a side against a spread. Rows numbered "T1.", "T2." etc (early
// Wed/Thu games) don't match the plain-digit pattern and are skipped too;
// see admin-pool's own note about those needing a separate early pick.
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
const NUM_RE = /^(\d{1,3})\.$/;

function parsePoolSheet(rows) {
  let weekNumber = null;
  let currentDay = null;
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
    const favM = favNumRaw.trim().match(NUM_RE);
    if (!favM) continue; // e.g. "T1." (early Wed/Thu game) -- not a plain number
    const favNum = parseInt(favM[1], 10);

    // The underdog's own number/name pair is somewhere later in the same
    // row -- find it by scanning instead of assuming a fixed column, since
    // the gap varies week to week (see header comment).
    let dogCol = -1;
    for (let i = 2; i < row.length; i++) {
      const c = row[i];
      if (typeof c === "string" && NUM_RE.test(c.trim())) { dogCol = i; break; }
    }
    if (dogCol === -1) continue;
    const dogNum = parseInt(row[dogCol].trim().match(NUM_RE)[1], 10);
    const dogName = row[dogCol + 1];
    if (typeof dogName !== "string") continue;
    if (dogNum !== favNum + 1) continue; // pairing looks off -- admin re-enters by hand

    // Total-points props ("UNDER"/"OVER") aren't a favorite/underdog game
    // -- this pool only supports picking a side against a spread.
    if (/^(UNDER|OVER)$/i.test(favName.trim()) || /^(UNDER|OVER)$/i.test(dogName.trim())) continue;

    // The spread is somewhere after the underdog's name -- same
    // "scan forward" reasoning as above. Stop at the first non-empty cell
    // so this can't skip past unrelated columns (like a side leaderboard)
    // and pick up some other section's number as if it were the spread.
    let spread = null;
    for (let i = dogCol + 2; i < row.length; i++) {
      const c = row[i];
      if (c == null) continue;
      if (typeof c === "string" && /^\+?\d+(\.\d+)?$/.test(c.trim())) spread = parseFloat(c.replace("+", ""));
      break;
    }

    games.push({
      sheetNumber: Math.ceil(favNum / 2),
      favorite: favName.trim(),
      underdog: dogName.trim(),
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
