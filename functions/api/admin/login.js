// functions/api/admin/login.js — POST /api/admin/login
// Body: { password }. One shared password (env.ADMIN_PASSWORD, set as a
// Cloudflare Pages secret -- never committed) gates the whole /admin-pool
// tool. On match, issues a signed, expiring cookie -- see _lib.js's
// adminCookieHeader() for how it's signed.
import { json, adminCookieHeader } from "../_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.ADMIN_PASSWORD) return json({ error: "admin login isn't configured yet (missing ADMIN_PASSWORD)" }, 500);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "invalid JSON body" }, 400);
    }

    const password = String(body.password || "");
    if (password !== env.ADMIN_PASSWORD) {
      return json({ error: "wrong password" }, 401);
    }

    const cookie = await adminCookieHeader(env);
    return json({ ok: true }, 200, { "set-cookie": cookie });
  } catch (e) {
    console.error("admin/login POST: uncaught exception", String((e && e.stack) || e));
    return json({ error: "unexpected server error" }, 500);
  }
}
