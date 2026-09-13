// functions/api/admin/parse-roster.js — POST /api/admin/parse-roster
// Admin-only: uploads the weekly ROSTER .xlsx (everyone's picks -- a
// different file from the games sheet parsed by parse-sheet.js) and
// resolves it into a review structure. Does NOT write to the database --
// admin-pool.html shows the review, then commits via save-roster.js,
// same two-step pattern as the games upload.
//
// This is for players who don't use the self-serve picks page (see
// picks.js) and instead still hand in picks the old way -- their picks
// land in their own `roster_picks` table, entirely separate from
// players/picks, so the two ways of picking never collide. See
// sheet-standings.js for how those get scored and shown.
//
// Sheet shape observed (row 1 = header, one row per participant after):
//   col with header "NICKNAME" = nickname
//   cols with header "10".."1" = the participant's picks for that
//     confidence value (read dynamically from the header text, in case
//     the column order/count ever shifts -- and matched on the LAST
//     occurrence of each header value, since some weeks' sheets carry an
//     earlier win/loss quick-view block that reuses the same "10".."1"
//     text before the real pick columns) -- each cell holds the pool
//     sheet's own printed label for the team they picked (e.g. "41", or
//     "T1"/"M2" for the lettered early/Monday games -- NOT our internal
//     sheet_number/game id).
//
// A raw label resolves back to a specific game_id/side by exact match
// against the sheet_label/sheet_label_dog this week's games were saved
// with (see save-week.js) -- favorite if it matches sheet_label, underdog
// if sheet_label_dog. That requires this week's games to already be saved
// before a roster upload. A raw label that doesn't match any saved game
// is reported in `unmatched` for the admin to fix by hand rather than
// silently dropped.
import { json, requireAdmin } from "../_lib.js";
import * as XLSX from "../../_vendor/xlsx.bundle.mjs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const denied = await requireAdmin(env, request);
    if (denied) return denied;

    if (!env.PICKS) return json({ error: "database isn't configured yet (missing PICKS binding)" }, 500);

    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return json({ error: "expected a multipart/form-data upload with 'sheet' and 'weekId' fields" }, 400);
    }

    const weekId = form.get("weekId");
    if (!weekId || typeof weekId !== "string") {
      return json({ error: "weekId is required -- save this week's games first, then upload its roster" }, 400);
    }

    const file = form.get("sheet");
    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ error: "no file found in the 'sheet' field" }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return json({ error: "file is too large (max 10MB)" }, 400);
    }

    const weekRow = await env.PICKS.prepare(`SELECT id, season, week_number, label FROM weeks WHERE id = ?`).bind(weekId).first();
    if (!weekRow) return json({ error: "no week found with that id -- save the games sheet for this week first" }, 400);

    const gamesRes = await env.PICKS.prepare(`SELECT id, sheet_number, sheet_label, sheet_label_dog FROM games WHERE week_id = ?`).bind(weekId).all();
    const games = gamesRes.results || [];
    if (!games.length) return json({ error: "this week has no games saved yet -- upload and save the games sheet first" }, 400);

    // rawLabel (trimmed, uppercased -- e.g. "41" or "T1") -> { gameId, side }.
    // Keyed off the exact printed labels save-week.js stores in
    // sheet_label/sheet_label_dog, rather than reconstructed from
    // sheet_number*2±1 -- that reconstruction only worked for
    // plain-numbered games; it could never match a lettered pick
    // ("T1"/"T2" for early Wed/Thu games, "M1"/"M2" for Monday's -- see
    // parse-sheet.js's header comment), since sheet_number for those
    // carries a large per-letter offset that doesn't invert back to "T1"
    // via *2±1.
    const byRaw = new Map();
    for (const g of games) {
      if (g.sheet_label != null) byRaw.set(String(g.sheet_label).trim().toUpperCase(), { gameId: g.id, side: "favorite" });
      if (g.sheet_label_dog != null) byRaw.set(String(g.sheet_label_dog).trim().toUpperCase(), { gameId: g.id, side: "underdog" });
    }

    let rows;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    } catch (e) {
      console.error("admin/parse-roster: xlsx read failed", String((e && e.message) || e));
      return json({ error: "couldn't read that file -- is it a valid .xlsx?" }, 400);
    }

    const parsed = parseRosterSheet(rows, byRaw);

    return json({
      ok: true,
      weekId,
      week: { season: weekRow.season, weekNumber: weekRow.week_number, label: weekRow.label },
      participants: parsed.participants,
      totalParticipants: parsed.participants.length,
      totalUnmatched: parsed.totalUnmatched,
      totalDuplicates: parsed.totalDuplicates,
      skipped: parsed.skipped // nicknames present but with zero picks (e.g. a placeholder row)
    });
  } catch (e) {
    console.error("admin/parse-roster POST: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}

function parseRosterSheet(rows, byRaw) {
  const header = rows[0] || [];
  // Find NICKNAME column and the point-value columns dynamically from the
  // header text rather than hardcoding indices, so a shifted layout next
  // season doesn't silently misparse.
  let nickCol = -1;
  // points (1..10) -> column index. A sheet can carry an earlier "this
  // week's result" quick-view block (win/loss letters, added starting
  // 2026-w2's 26W2S.xlsx) that reuses the same "10".."1" header text
  // before the real pick columns -- keep the LAST column seen for each
  // points value so that block gets overwritten by the real one instead
  // of both ending up in pointCols as duplicates.
  const pointColByPoints = new Map();
  header.forEach((cell, i) => {
    if (cell == null) return;
    const s = String(cell).trim().toUpperCase();
    if (s === "NICKNAME") { nickCol = i; return; }
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 10 && String(n) === s) pointColByPoints.set(n, i);
  });
  const pointCols = Array.from(pointColByPoints, ([points, col]) => ({ col, points }));

  const participants = [];
  const skipped = [];
  let totalUnmatched = 0;
  let totalDuplicates = 0;

  if (nickCol === -1 || !pointCols.length) return { participants, totalUnmatched: 0, totalDuplicates: 0, skipped };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const nicknameRaw = row[nickCol];
    if (nicknameRaw == null || !String(nicknameRaw).trim()) continue;
    const nickname = String(nicknameRaw).trim();

    const rawPicks = [];
    const unmatched = [];
    for (const { col, points } of pointCols) {
      const cell = row[col];
      if (cell == null || !String(cell).trim()) continue;
      const rawLabel = String(cell).trim().toUpperCase();
      const match = byRaw.get(rawLabel);
      if (!match) { unmatched.push({ points, raw: cell }); continue; }
      rawPicks.push({ points, rawNumber: rawLabel, gameId: match.gameId, side: match.side });
    }

    // Same team picked at two different point values -- keep the higher
    // (stronger) claim, drop the lower one, and report it instead of
    // letting the whole roster save fail over one person's slip.
    const byGameId = new Map();
    for (const pk of rawPicks) {
      if (!byGameId.has(pk.gameId)) byGameId.set(pk.gameId, []);
      byGameId.get(pk.gameId).push(pk);
    }
    const picks = [];
    const duplicates = [];
    for (const group of byGameId.values()) {
      if (group.length === 1) { picks.push(group[0]); continue; }
      group.sort((a, b) => b.points - a.points);
      picks.push(group[0]);
      for (const dropped of group.slice(1)) {
        duplicates.push({ kept: group[0].points, dropped: dropped.points, rawNumber: dropped.rawNumber });
      }
    }

    if (!picks.length && !unmatched.length) { skipped.push(nickname); continue; } // e.g. a placeholder row -- no picks submitted
    totalUnmatched += unmatched.length;
    totalDuplicates += duplicates.length;
    participants.push({ nickname, picks, unmatched, duplicates });
  }

  return { participants, totalUnmatched, totalDuplicates, skipped };
}
