// functions/api/admin/session.js — GET /api/admin/session
// Lets admin-pool.html check "is this browser already logged in" on load.
import { json, isAdminRequest } from "../_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authenticated = await isAdminRequest(env, request);
  return json({ authenticated });
}
