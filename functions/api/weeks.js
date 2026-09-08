// functions/api/weeks.js — GET /api/weeks
// Public, no auth: every week ever saved, newest first -- just enough to
// populate a "jump to a previous week" dropdown on the standings pages.
// week.js stays the one that returns a single week's own games; this one
// never touches games at all.
import { json } from "./_lib.js";

export async function onRequestGet(context) {
  const { env } = context;
  try {
    if (!env.PICKS) return json({ error: "database isn't configured yet (missing PICKS binding)" }, 500);

    const res = await env.PICKS.prepare(
      `SELECT id, season, week_number, label, deadline FROM weeks ORDER BY season DESC, week_number DESC`
    ).all();

    return json({ weeks: res.results || [] });
  } catch (e) {
    console.error("weeks GET: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
