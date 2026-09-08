// functions/api/sheet-standings.js — GET /api/sheet-standings?weekId=2025-w1
// Public: the leaderboard for picks entered from the paper/roster sheet
// (see admin/parse-roster.js and admin/save-roster.js), kept as its own
// separate standings from standings.js's self-serve leaderboard -- the
// two pools never mix, by design (see roster_picks in schema.sql).
//
// Scoring rule is identical to standings.js: a pick scores its points once
// its game is 'final' and the pick's side matches winner_side; a push or
// wrong side both score 0; anything not yet final is pending.
import { json } from "./_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    if (!env.PICKS) return json({ error: "database isn't configured yet (missing PICKS binding)" }, 500);

    const url = new URL(request.url);
    const weekIdParam = url.searchParams.get("weekId");

    let week;
    if (weekIdParam) {
      week = await env.PICKS.prepare(`SELECT id, season, week_number, label, deadline FROM weeks WHERE id = ?`).bind(weekIdParam).first();
      if (!week) return json({ error: "no week found with that id" }, 404);
    } else {
      week = await env.PICKS.prepare(`SELECT id, season, week_number, label, deadline FROM weeks ORDER BY created_at DESC LIMIT 1`).first();
      if (!week) return json({ week: null, standings: [] });
    }

    const res = await env.PICKS.prepare(
      `SELECT rp.nickname, rp.week_id, w.season, w.week_number, w.label,
              g.sheet_number, g.favorite, g.underdog, g.spread, g.status, g.winner_side,
              rp.side, rp.points
       FROM roster_picks rp
       JOIN weeks w ON w.id = rp.week_id
       JOIN games g ON g.id = rp.game_id
       ORDER BY rp.nickname, w.season, w.week_number, rp.points DESC`
    ).all();

    const rows = res.results || [];
    const byPlayer = new Map(); // keyed by normalized nickname, same as players.id would be

    for (const r of rows) {
      // Normalized purely for grouping here -- roster_picks has no id
      // column of its own the way players does, so "Paul" and " paul "
      // on two different weeks' sheets still land on one row.
      const key = String(r.nickname || "").trim().replace(/\s+/g, " ").toLowerCase();
      if (!byPlayer.has(key)) {
        byPlayer.set(key, {
          displayName: r.nickname,
          seasonTotal: 0, seasonPending: false, weekTotal: 0, weekPending: false, weekPicks: []
        });
      }
      const n = byPlayer.get(key);

      let result, earned;
      if (r.status !== "final") {
        result = "pending"; earned = null;
        n.seasonPending = true;
        if (r.week_id === week.id) n.weekPending = true;
      } else if (r.winner_side === "push" || r.winner_side !== r.side) {
        result = "loss"; earned = 0;
      } else {
        result = "win"; earned = r.points;
      }

      if (earned) {
        n.seasonTotal += earned;
        if (r.week_id === week.id) n.weekTotal += earned;
      }

      if (r.week_id === week.id) {
        n.weekPicks.push({
          sheetNumber: r.sheet_number, favorite: r.favorite, underdog: r.underdog, spread: r.spread,
          side: r.side, points: r.points, result, earned
        });
      }
    }

    const standings = [...byPlayer.values()].sort((a, b) => b.seasonTotal - a.seasonTotal || b.weekTotal - a.weekTotal || a.displayName.localeCompare(b.displayName));
    standings.forEach((n, i) => { n.rank = i + 1; });

    return json({
      week: { id: week.id, season: week.season, weekNumber: week.week_number, label: week.label, deadline: week.deadline },
      standings
    });
  } catch (e) {
    console.error("sheet-standings GET: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
