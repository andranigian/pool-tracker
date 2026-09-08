// functions/api/admin/save-week.js — POST /api/admin/save-week
// Admin-only. Body: { week: {id, season, weekNumber, label, deadline},
// games: [{sheetNumber, favorite, underdog, spread}, ...] }.
//
// Upserts on the UNIQUE(week_id, sheet_number) constraint rather than
// delete-then-reinsert. That matters the moment this gets used for
// in-season corrections: a delete+reinsert would silently reset any game
// that had already gone final (status/winner_side from refresh.js) back
// to "scheduled", and hand out fresh ids that orphan any picks already
// pointing at the old ones. This bit the hyedad version of this pool
// exactly once (games.js's original pool-save.js) before it got fixed --
// starting this one with the upsert from day one avoids repeating that.
import { json, requireAdmin } from "../_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const denied = await requireAdmin(env, request);
    if (denied) return denied;

    if (!env.PICKS) return json({ error: "database isn't configured yet (missing PICKS binding)" }, 500);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "invalid JSON body" }, 400);
    }

    const week = body.week || {};
    const games = Array.isArray(body.games) ? body.games : [];

    const weekId = String(week.id || "").trim();
    const season = parseInt(week.season, 10);
    const weekNumber = parseInt(week.weekNumber, 10);
    const deadline = week.deadline ? new Date(week.deadline) : null;

    if (!weekId) return json({ error: "week.id is required (e.g. 2026-w1)" }, 400);
    if (!Number.isFinite(season)) return json({ error: "week.season must be a number" }, 400);
    if (!Number.isFinite(weekNumber)) return json({ error: "week.weekNumber must be a number" }, 400);
    if (!deadline || Number.isNaN(deadline.getTime())) return json({ error: "week.deadline is required and must be a valid date/time" }, 400);
    if (!games.length) return json({ error: "at least one game is required" }, 400);

    for (const g of games) {
      if (!g.favorite || !g.underdog) return json({ error: "every game needs a favorite and an underdog" }, 400);
      if (!Number.isFinite(parseFloat(g.spread))) return json({ error: "every game needs a numeric spread" }, 400);
    }

    const sheetNumbers = games.map((g, i) => parseInt(g.sheetNumber, 10) || i + 1);
    const placeholders = sheetNumbers.map(() => "?").join(",");
    const statements = [
      env.PICKS.prepare(
        `INSERT INTO weeks (id, season, week_number, label, deadline) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET season=excluded.season, week_number=excluded.week_number, label=excluded.label, deadline=excluded.deadline`
      ).bind(weekId, season, weekNumber, week.label || null, deadline.toISOString()),
      ...games.map((g, i) =>
        env.PICKS.prepare(
          `INSERT INTO games (week_id, sheet_number, favorite, underdog, spread) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(week_id, sheet_number) DO UPDATE SET favorite=excluded.favorite, underdog=excluded.underdog, spread=excluded.spread`
        ).bind(weekId, sheetNumbers[i], g.favorite.trim(), g.underdog.trim(), parseFloat(g.spread))
      ),
      // Only drop games no longer in this save (e.g. removed during
      // review) -- everything else keeps its id/status/winner_side.
      env.PICKS.prepare(`DELETE FROM games WHERE week_id = ? AND sheet_number NOT IN (${placeholders})`).bind(weekId, ...sheetNumbers)
    ];
    await env.PICKS.batch(statements);

    return json({ ok: true, weekId, gamesSaved: games.length });
  } catch (e) {
    console.error("admin/save-week POST: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
