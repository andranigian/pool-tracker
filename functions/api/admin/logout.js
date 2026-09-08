// functions/api/admin/logout.js — POST /api/admin/logout
import { json, adminCookieHeader } from "../_lib.js";

export async function onRequestPost(context) {
  const cookie = await adminCookieHeader(context.env, { clear: true });
  return json({ ok: true }, 200, { "set-cookie": cookie });
}
