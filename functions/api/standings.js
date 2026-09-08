// functions/api/standings.js — GET /api/standings?weekId=2026-w1
// Public: every player's season-long running total, plus their
// breakdown for one specific week (defaults to the most recently created
// week). Aggregated across ALL picks ever made, not just the current
// week -- season totals just accumulate automatically as more weeks get
// added, no separate rollup step needed.
//
// A pick scores its points once its game is 'final' and the pick's side
// matches winner_side; a push or wrong side both score 0 (this pool's
// "ties lose" rule); anything not yet final is pending.
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
      week = await env.PICKS.prepare(`SELECT id, season, week_number, label, deadline FROM weeks ORDER BY season DESC, week_number DESC LIMIT 1`).first();
      if (!week) return json({ week: null, standings: [] });
    }

    const res = await env.PICKS.prepare(
      `SELECT p.player_id, pl.display_name, p.week_id, w.season, w.week_number, w.label,
              g.sheet_number, g.market, g.favorite, g.underdog, g.spread, g.status, g.winner_side,
              g.fav_score, g.dog_score,
              p.side, p.points
       FROM picks p
       JOIN players pl ON pl.id = p.player_id
       JOIN weeks w ON w.id = p.week_id
       JOIN games g ON g.id = p.game_id
       ORDER BY pl.display_name, w.season, w.week_number, p.points DESC`
    ).all();

    const rows = res.results || [];
    const byPlayer = new Map();

    for (const r of rows) {
      if (!byPlayer.has(r.player_id)) {
        byPlayer.set(r.player_id, {
          playerId: r.player_id, displayName: r.display_name,
          seasonTotal: 0, seasonPending: false, weekTotal: 0, weekPending: false, weekPicks: []
        });
      }
      const n = byPlayer.get(r.player_id);

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
          sheetNumber: r.sheet_number, market: r.market, favorite: r.favorite, underdog: r.underdog, spread: r.spread,
          favScore: r.fav_score, dogScore: r.dog_score,
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
    console.error("standings GET: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
