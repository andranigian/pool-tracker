// functions/api/admin/save-roster.js — POST /api/admin/save-roster
// Admin-only: commits the reviewed roster (everyone's picks for a week,
// from parse-roster.js) into `roster_picks` -- a table that's entirely
// separate from players/picks (the self-serve system, see picks.js), so
// the two ways of picking can never collide or overwrite each other.
//
// Re-saving the same weekId replaces that week's whole roster (full
// delete+reinsert) -- roster_picks carries no independently-arrived-at
// state of its own (same reasoning as picks.js's POST handler), so a
// clean replace on every save is safe and simplest here too.
//
// D1's batch() has a practical limit on statements per call, and a full
// roster can be 150-200+ participants x up to 10 picks each, so inserts
// are chunked across multiple batch() calls rather than sent as one.
import { json, requireAdmin } from "../_lib.js";

const CHUNK_SIZE = 400; // statements per D1 batch() call

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

    const weekId = body && body.weekId;
    const participants = Array.isArray(body && body.participants) ? body.participants : [];

    if (!weekId || typeof weekId !== "string") {
      return json({ error: "weekId is required" }, 400);
    }
    const weekRow = await env.PICKS.prepare(`SELECT id FROM weeks WHERE id = ?`).bind(weekId).first();
    if (!weekRow) return json({ error: "no week found with that id" }, 400);

    if (!participants.length) {
      return json({ error: "at least one participant is required" }, 400);
    }

    const validGameIds = new Set((await env.PICKS.prepare(`SELECT id FROM games WHERE week_id = ?`).bind(weekId).all()).results.map(g => g.id));

    const inserts = [];
    for (const p of participants) {
      if (typeof p.nickname !== "string" || !p.nickname.trim()) {
        return json({ error: "every participant needs a nickname" }, 400);
      }
      const nickname = p.nickname.trim();
      const picks = Array.isArray(p.picks) ? p.picks : [];
      if (picks.length > 10) {
        return json({ error: `${nickname}: too many picks (max 10)` }, 400);
      }
      const seenPoints = new Set();
      const seenGames = new Set();
      for (const pk of picks) {
        const points = parseInt(pk.points, 10);
        const gameId = parseInt(pk.gameId, 10);
        if (!Number.isFinite(points) || points < 1 || points > 10) {
          return json({ error: `${nickname}: invalid points value` }, 400);
        }
        if (pk.side !== "favorite" && pk.side !== "underdog") {
          return json({ error: `${nickname}: side must be favorite or underdog` }, 400);
        }
        if (!validGameIds.has(gameId)) {
          return json({ error: `${nickname}: game ${gameId} doesn't belong to this week` }, 400);
        }
        if (seenPoints.has(points)) {
          return json({ error: `${nickname}: duplicate point value ${points}` }, 400);
        }
        if (seenGames.has(gameId)) {
          return json({ error: `${nickname}: duplicate game in picks` }, 400);
        }
        seenPoints.add(points);
        seenGames.add(gameId);
        inserts.push(
          env.PICKS.prepare(
            `INSERT INTO roster_picks (week_id, nickname, game_id, side, points) VALUES (?, ?, ?, ?, ?)`
          ).bind(weekId, nickname, gameId, pk.side, points)
        );
      }
    }

    try {
      // Delete-then-reinsert as its own batch first so a failure partway
      // through the inserts never leaves half-old/half-new rows.
      await env.PICKS.batch([env.PICKS.prepare(`DELETE FROM roster_picks WHERE week_id = ?`).bind(weekId)]);
      for (let i = 0; i < inserts.length; i += CHUNK_SIZE) {
        await env.PICKS.batch(inserts.slice(i, i + CHUNK_SIZE));
      }
    } catch (e) {
      console.error("admin/save-roster POST: D1 batch failed", String((e && e.message) || e));
      return json({ error: "couldn't save -- try again" }, 500);
    }

    return json({ ok: true, weekId, participantsSaved: participants.length, picksSaved: inserts.length });
  } catch (e) {
    console.error("admin/save-roster POST: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
