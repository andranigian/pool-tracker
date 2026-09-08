// functions/api/refresh.js — POST /api/refresh
// Public, no auth. There's no server-side cron here on purpose: Cloudflare
// Workers calling ESPN's scoreboard directly gets a flat 403 (ESPN's bot
// protection blocks Cloudflare's outbound IP ranges, not the request shape
// -- confirmed on the hyedad version of this same pool, which is why that
// one also fetches client-side). A visitor's browser fetches ESPN itself
// (see index.html/standings.html) and pushes what it saw back here.
//
// Trust model: a visitor's browser only ever reports RAW SCORES
// (favScore/dogScore/completed/inProgress) -- it never gets to say who
// covered the spread. winner_side is always recomputed here from the
// game's own stored spread, so the pool's actual scoring rule can't be
// spoofed even by a malicious client; only the "is this game over and
// what was the score" fact is client-supplied, and a submission can only
// move a game towards final, never edit one that's already final or
// cancelled.
import { json } from "./_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.PICKS) return json({ error: "database isn't configured yet (missing PICKS binding)" }, 500);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "invalid JSON body" }, 400);
    }

    const updates = Array.isArray(body && body.updates) ? body.updates : [];
    if (!updates.length) return json({ ok: true, applied: 0 });

    const ids = [...new Set(updates.map(u => parseInt(u.gameId, 10)).filter(Number.isFinite))];
    if (!ids.length) return json({ ok: true, applied: 0 });

    const placeholders = ids.map(() => "?").join(",");
    const gamesRes = await env.PICKS.prepare(
      `SELECT id, spread, status, fav_score, dog_score FROM games WHERE id IN (${placeholders}) AND status NOT IN ('final','cancelled')`
    ).bind(...ids).all();
    const pending = new Map((gamesRes.results || []).map(g => [g.id, g]));

    const writes = [];
    for (const u of updates) {
      const gameId = parseInt(u.gameId, 10);
      const game = pending.get(gameId);
      if (!game) continue;

      const favScore = Number(u.favScore);
      const dogScore = Number(u.dogScore);
      if (!Number.isFinite(favScore) || !Number.isFinite(dogScore) || favScore < 0 || dogScore < 0) continue;

      let newStatus = "scheduled";
      if (u.completed) newStatus = "final";
      else if (u.inProgress) newStatus = "in_progress";
      // Scores can tick up during the same in_progress status (a later
      // fetch mid-game reports a higher score), so write whenever either
      // the status or a score actually changed -- not just on a status
      // transition -- otherwise a mid-game update never sticks.
      if (newStatus === game.status && favScore === game.fav_score && dogScore === game.dog_score) continue;

      let winnerSide = null;
      if (newStatus === "final") {
        const favMargin = favScore - dogScore;
        winnerSide = favMargin > game.spread ? "favorite" : favMargin < game.spread ? "underdog" : "push";
      }
      writes.push(
        env.PICKS.prepare(`UPDATE games SET status = ?, winner_side = ?, fav_score = ?, dog_score = ? WHERE id = ?`)
          .bind(newStatus, winnerSide, favScore, dogScore, gameId)
      );
    }

    if (writes.length) await env.PICKS.batch(writes);

    return json({ ok: true, applied: writes.length });
  } catch (e) {
    console.error("refresh POST: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
