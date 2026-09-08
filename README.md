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

- `index.html` — the self-serve picks page (`/`). Nickname + PIN, make
  picks, see your season standing. Scores refresh automatically from ESPN
  when this page (or either standings page) loads.
- `standings.html` — public leaderboard for self-serve picks (`/standings`).
- `sheet-standings.html` — public leaderboard for picks entered from the
  paper/roster sheet (`/sheet-standings`) — see "Two separate pools" below.
- `admin-pool.html` — admin tool (`/admin-pool`), password-gated. Upload
  the week's `.xlsx` games sheet, review the parsed games, save. Also
  where the weekly roster sheet (everyone's picks, for players who don't
  use the self-serve page) gets uploaded.
- `functions/api/` — the backend (Cloudflare Pages Functions):
  - `week.js`, `standings.js`, `sheet-standings.js`, `picks.js`,
    `refresh.js` — public.
  - `admin/login.js`, `admin/logout.js`, `admin/session.js`,
    `admin/save-week.js`, `admin/parse-sheet.js`, `admin/parse-roster.js`,
    `admin/save-roster.js` — admin-only, gated by a signed cookie issued
    on password login (see `_lib.js`).
- `functions/_vendor/xlsx.bundle.mjs` — the `.xlsx` parser, pre-bundled
  (no build step runs on this Pages project, so a bare `import "xlsx"`
  could never resolve).
- `schema.sql` — the D1 schema. Safe to re-run any time (every statement
  is `CREATE TABLE/INDEX IF NOT EXISTS`) — re-running it after pulling a
  newer version of this repo is how you pick up any new tables, like
  `roster_picks` below, without touching your existing data.
- `migrate-week1.sql` — one-time copy of this week's games from the
  hyedad pool (see "Migrating this week's games" below).

## Two separate pools, on purpose

There are two independent ways picks get into this site, and they never
mix:

- **Self-serve** — a player goes to `/`, picks a nickname + PIN, and
  enters their own picks directly. Scored on `/standings`. Ranks however
  many games are on the sheet that week (`players`/`picks` tables).
- **Sheet/roster** — for players who still hand in picks the old way
  (paper, text, whatever) instead of using the web page. You collect them
  into the same roster `.xlsx` format hyedad used and upload it in
  `/admin-pool`'s "Weekly roster" section; it resolves everyone's picks
  against that week's saved games and reviews unmatched/duplicate entries
  before you commit them. Scored separately on `/sheet-standings`. Always
  the classic 10-pick confidence scale (1-10), matching the paper sheet's
  own fixed format regardless of how many games are on it.

They're kept in separate tables (`picks` vs `roster_picks`) specifically
so uploading a roster can never overwrite or collide with someone's
self-serve picks, even if the same person's nickname shows up in both.

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
- Visit `/standings` to see the self-serve leaderboard.
- If you're also collecting picks the old way (paper/text), upload that
  roster sheet in `/admin-pool`'s "Weekly roster" section, then check
  `/sheet-standings`.

### If you already deployed before this feature existed

Re-run `schema.sql` once to add the new `roster_picks` table — it's
additive and safe, nothing else in the database is touched:

```
npx wrangler d1 execute pool-tracker --remote --file=schema.sql
```

Then redeploy (push a commit, or Deployments → Retry) so the new
`/admin-pool` roster section and `/sheet-standings` page go live.

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
- **Sheet/roster picks are a separate table from self-serve picks.** A
  roster re-upload does a full delete+reinsert of `roster_picks` for that
  week, same reasoning as `picks.js` (no independently-arrived-at state to
  preserve there) — but it only ever touches `roster_picks`, never
  `players`/`picks`, so it can't clobber anyone's self-serve entries.
