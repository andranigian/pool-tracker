# Pool Tracker

A standalone weekly confidence pool. No sign-in for players — pick a
nickname and a PIN the first time you make picks, and that's it. One admin
password protects `/admin-pool`, where each week's games/spreads get
uploaded (from an `.xlsx` sheet) or entered by hand.

Completely independent of hyedad.com's infrastructure: its own Cloudflare
Pages project, its own D1 database, its own domain (a `.pages.dev` one to
start). Nothing here depends on hyedad's shared auth system, KV namespace,
or D1 database — the two sites can be developed and deployed without
touching each other at all.

## How it's laid out

- `index.html` — the picks page (`/`). Nickname + PIN, make picks, see your
  season standing. Scores refresh automatically from ESPN when this page
  (or the standings page) loads.
- `standings.html` — public leaderboard (`/standings`).
- `admin-pool.html` — admin tool (`/admin-pool`), password-gated. Upload
  the week's `.xlsx` sheet, review the parsed games, save.
- `functions/api/` — the backend (Cloudflare Pages Functions):
  - `week.js`, `standings.js`, `picks.js`, `refresh.js` — public.
  - `admin/login.js`, `admin/logout.js`, `admin/session.js`,
    `admin/save-week.js`, `admin/parse-sheet.js` — admin-only, gated by
    a signed cookie issued on password login (see `_lib.js`).
- `functions/_vendor/xlsx.bundle.mjs` — the `.xlsx` parser, pre-bundled
  (no build step runs on this Pages project, so a bare `import "xlsx"`
  could never resolve).
- `schema.sql` — the D1 schema.
- `migrate-week1.sql` — one-time copy of this week's games from the
  hyedad pool (see "Migrating this week's games" below).

## One-time setup

All of this is done through the Cloudflare dashboard or `wrangler` run
from **your own terminal** (not through Claude) — creating cloud
resources needs your own authenticated Cloudflare session.

### 1. Create the GitHub repo and push this code

```
cd ~/Documents/trackers/pool-tracker
git init
git add .
git commit -m "Initial commit: standalone confidence pool"
```

Then create an empty repo on GitHub named `pool-tracker` (github.com/new,
do NOT initialize it with a README), and:

```
git remote add origin https://github.com/<your-github-username>/pool-tracker.git
git branch -M main
git push -u origin main
```

### 2. Create the D1 database

```
npx wrangler d1 create pool-tracker
```

This prints a `database_id` — save it, you'll enter it in the dashboard
in step 4.

Load the schema:

```
npx wrangler d1 execute pool-tracker --remote --file=schema.sql
```

### 3. Migrating this week's games (optional)

`migrate-week1.sql` carries over this week's 41 games from the hyedad
site (fetched 2026-09-08 — all still `scheduled`, nothing final yet, so
nothing is lost by copying it over as-is):

```
npx wrangler d1 execute pool-tracker --remote --file=migrate-week1.sql
```

This does **not** bring over any picks/roster data — the hyedad
standings endpoint is currently erroring out, so there's no reliable way
to read that back. If you want to check whether there's anything worth
saving there, ask me to look into that hyedad bug separately; it's not
part of this new site.

If you'd rather start completely fresh instead, skip this step and just
enter Week 1 by hand in `/admin-pool` once it's live.

### 4. Create the Cloudflare Pages project

In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect
to Git**, pick the `pool-tracker` repo, branch `main`. Build settings:
leave the build command **empty** (no build step — same as your other two
sites) and the output directory as `/` (the repo root).

Once it's created, go to the project's **Settings**:

- **Functions → D1 database bindings**: add a binding named `PICKS`
  pointing at the `pool-tracker` database you created in step 2.
- **Settings → Environment variables → Secrets**: add `ADMIN_PASSWORD`
  with whatever password you want to use for `/admin-pool`. Pick
  something you don't reuse elsewhere — this is the only thing standing
  between the public internet and being able to rewrite your games.

Redeploy once (Deployments → Retry deployment) after adding the binding
and secret, since they only take effect on new deployments.

Your site will be live at `https://pool-tracker-<hash>.pages.dev` (or
whatever name Cloudflare assigns) right away. Point a real domain at it
whenever you're ready — Pages → Custom domains.

### 5. Try it

- Visit `/admin-pool`, sign in with your `ADMIN_PASSWORD`, and either
  upload an `.xlsx` sheet or add games by hand, then save.
- Visit `/`, pick a nickname + PIN, and make some picks.
- Visit `/standings` to see the leaderboard.

## Notes on the design

- **No CORS needed.** Because this is one domain serving both the pages
  and the API (unlike hyedad's split between `www.` and `fantasy.`
  subdomains), every request here is same-origin. `functions/api/_lib.js`
  has none of the cross-origin allowlist logic the hyedad version needed.
- **Admin sessions need no database.** The signed cookie is an HMAC of an
  expiry timestamp, keyed by `ADMIN_PASSWORD` itself — verifying it is
  just recomputing the HMAC, no session table or KV namespace required.
- **Player identity is intentionally lightweight.** A nickname's PIN is
  only there to stop accidental/malicious overwrites, not to be a real
  account system — there's no password reset, because there's nothing to
  reset: if someone forgets their PIN, they just... pick a new nickname.
- **Games are upserted, not delete-and-reinserted**, on every admin save
  (`admin/save-week.js`) — a lesson learned the hard way on the hyedad
  version, where a resave used to silently wipe every game's score back
  to "scheduled." This one avoids that from day one.

<!-- redeploy trigger: 2026-09-08T03:45:30Z -->
