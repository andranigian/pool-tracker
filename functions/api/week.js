// functions/api/week.js — GET /api/week?id=2026-w1
// Public, no auth: the week's games and spreads. Omit ?id for the current
// week -- the one with the highest (season, week_number), NOT the one
// most recently inserted (a one-time backfill/migration can insert an
// older week well after the real current one already exists, which
// would otherwise hijack "current" from it).
import { json } from "./_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    if (!env.PICKS) return json({ error: "database isn't configured yet (missing PICKS binding)" }, 500);

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    let week;
    try {
      week = id
        ? await env.PICKS.prepare(`SELECT * FROM weeks WHERE id = ?`).bind(id).first()
        : await env.PICKS.prepare(`SELECT * FROM weeks ORDER BY season DESC, week_number DESC LIMIT 1`).first();
    } catch (e) {
      console.error("week GET: weeks query failed", String((e && e.message) || e));
      return json({ error: "couldn't read the database" }, 500);
    }

    if (!week) return json({ week: null, games: [] });

    let games;
    try {
      const res = await env.PICKS.prepare(
        `SELECT id, sheet_number, sheet_label, market, favorite, underdog, spread, status, winner_side, fav_score, dog_score FROM games WHERE week_id = ? ORDER BY sheet_number`
      ).bind(week.id).all();
      games = res.results || [];
    } catch (e) {
      console.error("week GET: games query failed", String((e && e.message) || e));
      return json({ error: "couldn't read the database" }, 500);
    }

    return json({ week, games });
  } catch (e) {
    console.error("week GET: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
