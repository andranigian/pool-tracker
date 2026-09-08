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
//     the column order/count ever shifts) -- each cell holds the pool
//     sheet's own raw number for the team they picked (NOT our internal
//     sheet_number/game id).
//
// The pool sheet numbers each team-slot sequentially (favorite = odd, its
// underdog = the very next even number, e.g. 41/42) and our sheet_number
// is that pair collapsed to one game index (see parse-sheet.js's header
// comment) -- so a raw number resolves back to a specific game_id/side via
// gameId = the game whose sheet_number is ceil(rawNumber/2), side =
// "favorite" if rawNumber is odd else "underdog". That requires this
// week's games to already be saved (save-week.js) before a roster upload.
// A raw number that doesn't match any saved game is reported in
// `unmatched` for the admin to fix by hand rather than silently dropped.
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

    const gamesRes = await env.PICKS.prepare(`SELECT id, sheet_number FROM games WHERE week_id = ?`).bind(weekId).all();
    const games = gamesRes.results || [];
    if (!games.length) return json({ error: "this week has no games saved yet -- upload and save the games sheet first" }, 400);

    // rawNumber -> { gameId, side }
    const byRaw = new Map();
    for (const g of games) {
      byRaw.set(g.sheet_number * 2 - 1, { gameId: g.id, side: "favorite" });
      byRaw.set(g.sheet_number * 2, { gameId: g.id, side: "underdog" });
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
  const pointCols = []; // [{ col, points }]
  header.forEach((cell, i) => {
    if (cell == null) return;
    const s = String(cell).trim().toUpperCase();
    if (s === "NICKNAME") { nickCol = i; return; }
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 10 && String(n) === s) pointCols.push({ col: i, points: n });
  });

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
      const rawNumber = parseInt(String(cell).trim(), 10);
      if (!Number.isFinite(rawNumber)) { unmatched.push({ points, raw: String(cell) }); continue; }
      const match = byRaw.get(rawNumber);
      if (!match) { unmatched.push({ points, raw: rawNumber }); continue; }
      rawPicks.push({ points, rawNumber, gameId: match.gameId, side: match.side });
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
