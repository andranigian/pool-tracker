// functions/api/admin/parse-sheet.js — POST /api/admin/parse-sheet
// Admin-only: uploads a weekly confidence-pool .xlsx, parses it into a
// week + games structure for review. Does NOT write to the database --
// admin-pool.html shows the parsed result for review/edits, then confirms
// via /api/admin/save-week.
//
// Ported from the hyedad version of this pool (league-tracker's
// pool-parse.js) -- same sheet layout, same parsing rules, just gated by
// this site's own admin cookie instead of a shared hyedad login. Fixed
// column shape observed in the sheet (0-indexed, header:1 array-of-arrays):
//   col 0  = favorite's number, e.g. "1."      col 1 = favorite name
//   col 8  = underdog's number, e.g. "2."      col 9 = underdog name
//   col 15 = spread on the underdog, e.g. "+2"
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
    const dogNumRaw = row[8], dogName = row[9];
    const spreadRaw = row[15];

    if (typeof favNumRaw !== "string" || typeof dogNumRaw !== "string") continue;
    const favM = favNumRaw.trim().match(NUM_RE);
    const dogM = dogNumRaw.trim().match(NUM_RE);
    if (!favM || !dogM) continue;
    if (typeof favName !== "string" || typeof dogName !== "string") continue;

    const favNum = parseInt(favM[1], 10);
    const dogNum = parseInt(dogM[1], 10);
    if (dogNum !== favNum + 1) continue; // pairing looks off -- admin re-enters by hand

    const spread = typeof spreadRaw === "string" && /^\+?\d+(\.\d+)?$/.test(spreadRaw.trim())
      ? parseFloat(spreadRaw.replace("+", ""))
      : null;

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
