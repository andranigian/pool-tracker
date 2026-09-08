// functions/api/_lib.js — shared helpers for Pool Tracker's API routes.
// Underscore-prefixed, so Cloudflare Pages Functions excludes it from
// routing (same convention the hyedad repos use for their own _lib.js).
//
// This site is intentionally standalone -- one domain serves both the
// static pages and these Functions, so every request here is same-origin.
// That means none of the CORS/CSRF machinery the hyedad version of this
// file needed (see league-tracker's functions/api/auth/_lib.js) applies:
// there's no cross-subdomain fetch to allow, so there's nothing to gate.
//
// Two independent identity systems, both deliberately account-free:
//   - Players: a nickname + PIN they pick themselves the first time they
//     make a pick. The PIN isn't a password in any serious sense -- it
//     just stops someone else from typing the same nickname and
//     overwriting your picks by accident. See hashPin()/verifyPin().
//   - Admin: one shared password (an env var / Cloudflare secret,
//     ADMIN_PASSWORD), gating /admin-pool and its save endpoints. A
//     successful login gets a signed, expiring cookie -- signed with an
//     HMAC keyed off the password itself, so no separate secret or KV
//     namespace is needed just to track sessions. See adminCookie*().

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

export function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  const m = raw.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(keyText, message) {
  const keyBytes = new TextEncoder().encode(keyText);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}

// ==================== PLAYERS (nickname + PIN) ====================

// Normalizes a nickname to its lookup key: trimmed, lowercased, internal
// whitespace collapsed. "Paul" and " paul  " land on the same player row;
// display_name keeps whatever casing was actually typed.
export function normalizePlayerId(nickname) {
  return String(nickname || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Salted with the player's own id so the same PIN ("1234") doesn't hash
// the same way for two different nicknames.
export function hashPin(playerId, pin) {
  return sha256Hex(playerId + ":" + String(pin || ""));
}

export async function verifyPin(playerId, pin, storedHash) {
  return (await hashPin(playerId, pin)) === storedHash;
}

// ==================== ADMIN SESSION ====================

const ADMIN_COOKIE = "pt_admin";
const ADMIN_SESSION_DAYS = 30;

export async function adminCookieHeader(env, { clear = false } = {}) {
  if (clear) {
    return `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  }
  const expiresAt = Date.now() + ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000;
  const sig = await hmacHex(env.ADMIN_PASSWORD, String(expiresAt));
  const value = encodeURIComponent(expiresAt + "." + sig);
  const maxAge = ADMIN_SESSION_DAYS * 24 * 60 * 60;
  return `${ADMIN_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export async function isAdminRequest(env, request) {
  if (!env.ADMIN_PASSWORD) return false;
  const raw = getCookie(request, ADMIN_COOKIE);
  if (!raw) return false;
  const dot = raw.indexOf(".");
  if (dot === -1) return false;
  const expiresAt = parseInt(raw.slice(0, dot), 10);
  const sig = raw.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = await hmacHex(env.ADMIN_PASSWORD, String(expiresAt));
  return expected === sig;
}

// Small helper for routes that should 401 instead of silently no-op'ing
// when the admin cookie is missing/expired/invalid.
export async function requireAdmin(env, request) {
  const ok = await isAdminRequest(env, request);
  if (!ok) return json({ error: "not signed in as admin" }, 401);
  return null; // null == "go ahead"
}
