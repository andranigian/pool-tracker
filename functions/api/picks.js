// functions/api/picks.js — GET/POST /api/picks
// No sign-in: identity here is just a nickname + PIN chosen on first use
// (see _lib.js's header comment). Reading a player's picks needs no PIN --
// nicknames aren't secret and everyone's picks become visible in standings
// anyway once the deadline passes -- but WRITING (claiming a nickname for
// the first time, or changing that nickname's picks later) requires the
// matching PIN, which is the only thing stopping one person from
// overwriting another person's picks by typing the same nickname.
import { json, normalizePlayerId, hashPin, verifyPin } from "./_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    if (!env.PICKS) return json({ error: "database isn't configured yet (missing PICKS binding)" }, 500);
    const url = new URL(request.url);
    const nickname = url.searchParams.get("player") || "";
    const weekId = url.searchParams.get("weekId") || "";
    const playerId = normalizePlayerId(nickname);
    if (!playerId || !weekId) return json({ error: "player and weekId are both required" }, 400);

    const res = await env.PICKS.prepare(
      `SELECT game_id, side, points FROM picks WHERE player_id = ? AND week_id = ?`
    ).bind(playerId, weekId).all();

    return json({ picks: res.results || [] });
  } catch (e) {
    console.error("picks GET: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}

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

    const nickname = String(body.nickname || "").trim();
    const pin = String(body.pin || "");
    const weekId = String(body.weekId || "").trim();
    const picks = Array.isArray(body.picks) ? body.picks : [];

    const playerId = normalizePlayerId(nickname);
    if (!playerId) return json({ error: "enter a nickname" }, 400);
    if (!/^\d{4,8}$/.test(pin)) return json({ error: "PIN must be 4-8 digits" }, 400);
    if (!weekId) return json({ error: "weekId is required" }, 400);

    const week = await env.PICKS.prepare(`SELECT id, deadline FROM weeks WHERE id = ?`).bind(weekId).first();
    if (!week) return json({ error: "no such week" }, 404);
    if (new Date(week.deadline).getTime() < Date.now()) {
      return json({ error: "picks are locked for this week — the deadline has passed" }, 403);
    }

    // Claim-or-verify: the first person to use a nickname sets its PIN;
    // everyone after that has to match it.
    const existing = await env.PICKS.prepare(`SELECT pin_hash FROM players WHERE id = ?`).bind(playerId).first();
    if (existing) {
      if (!(await verifyPin(playerId, pin, existing.pin_hash))) {
        return json({ error: "that nickname is taken and this PIN doesn't match it — try a different nickname, or the PIN you set for this one" }, 403);
      }
    } else {
      const pinHash = await hashPin(playerId, pin);
      await env.PICKS.prepare(
        `INSERT INTO players (id, display_name, pin_hash) VALUES (?, ?, ?)`
      ).bind(playerId, nickname, pinHash).run();
    }

    // Validate picks against this week's real games so a bad gameId or a
    // side that doesn't exist can't wedge in something nonsensical.
    const gamesRes = await env.PICKS.prepare(`SELECT id FROM games WHERE week_id = ?`).bind(weekId).all();
    const validGameIds = new Set((gamesRes.results || []).map(g => g.id));

    const seenGames = new Set();
    const seenPoints = new Set();
    const clean = [];
    for (const p of picks) {
      const gameId = parseInt(p.gameId, 10);
      const points = parseInt(p.points, 10);
      const side = p.side === "favorite" || p.side === "underdog" ? p.side : null;
      if (!validGameIds.has(gameId) || !side || !Number.isFinite(points) || points < 1) continue;
      if (seenGames.has(gameId) || seenPoints.has(points)) continue; // same game or same point value twice -- keep the first, drop the rest
      seenGames.add(gameId);
      seenPoints.add(points);
      clean.push({ gameId, side, points });
    }

    // Full replace for this player+week -- picks carry no independently-
    // arrived-at state of their own (unlike games.status, which is why
    // *that* table gets upserted instead -- see admin/save-week.js), so a
    // clean delete+reinsert on every save is safe and simplest.
    const statements = [
      env.PICKS.prepare(`DELETE FROM picks WHERE player_id = ? AND week_id = ?`).bind(playerId, weekId),
      ...clean.map(p =>
        env.PICKS.prepare(
          `INSERT INTO picks (player_id, week_id, game_id, side, points) VALUES (?, ?, ?, ?, ?)`
        ).bind(playerId, weekId, p.gameId, p.side, p.points)
      )
    ];
    await env.PICKS.batch(statements);

    return json({ ok: true, picksSaved: clean.length, skipped: picks.length - clean.length });
  } catch (e) {
    console.error("picks POST: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
