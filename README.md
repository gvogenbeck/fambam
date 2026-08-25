# FamBam Fantasy Football — deploy notes

This site is now backed by a small shared database, so everyone sees the
same roster board and poll results — not just whoever's browser made the
edit. Here's how to get it live.

## 1. Push to GitHub

Put this whole `fambam` folder (including `api/`, `package.json`, and
`fambam-data.js`) in a GitHub repo.

## 2. Import into Vercel

Vercel dashboard → **Add New → Project** → pick the repo. No build
command needed — leave the framework preset as "Other" and the output
directory as the repo root. Deploy once now; it'll work for the static
pages, but the API calls will fail until step 3 is done (you'll see a
"Cannot reach the league data" message on the pages — that's expected).

## 3. Add a Redis store (Vercel KV is retired — use Upstash instead)

Vercel KV was sunset; the current path is the same idea, just through
the Marketplace:

1. In your Vercel project → **Storage** tab → **Marketplace Database
   Storage** (or **Connect Store**) → choose **Upstash — Redis**.
2. Create a new database (the free tier is plenty for this).
3. Link it to this project. Vercel will automatically add two
   environment variables to the project: `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` (the Upstash SDK reads these automatically).
4. Redeploy the project (Vercel usually prompts you to; if not,
   Deployments tab → "..." → Redeploy) so the new env vars take effect.

That's it — `/api/state` should now return real data instead of an
error, and the site will work for everyone.

## 4. Add your domain

Project → **Domains** → add your domain → follow the DNS instructions
Vercel gives you (usually one CNAME record at your registrar). Free
HTTPS is automatic.

## How the data flows

- `fambam-data.js` is the only file that talks to the API. Every page
  calls `DB.load()` once, then reads from an in-memory cache; every
  edit writes through to the server first.
- `admin.html` writes are the only ones that change the roster, polls,
  or settings. `index.html` is read-only except for casting votes.
- Vote counts live in Redis hashes (`poll:<id>:counts`); who-voted-for-what
  lives in a separate hash (`poll:<id>:voters`) so a person can change
  their vote without double-counting. There's no login, so a random id
  is generated per browser and stored in `localStorage` to identify
  "this device already voted" — nothing that identifies a person.
- The admin page's manual vote-count fields (for recording votes given
  in person) directly overwrite the count for that option — they don't
  interact with the voter-tracking hash, so if someone later changes
  their online vote after a manual override, the math might look a
  little odd. Not a real concern at this scale.

## Archiving the site for the offseason

Once the season's over and nobody needs to edit or vote anymore, set
the environment variable `ARCHIVE_MODE` to `true` in Vercel's project
settings and redeploy. Every write endpoint (`board`, `settings`,
`polls`, `vote`, `poll-admin`, `reset`) then rejects requests with a
clear 403 message — but `state` (the read that powers both pages)
keeps working, so the frozen roster and poll results stay visible.
This is the safest way to leave the site sitting online unattended:
there's no write path left to abuse.

To bring it back for a new season, see **REACTIVATE.md** — it walks
through un-freezing the site, resetting or carrying over last year's
roster and poll data, and what parts of the homepage are safe to
rewrite versus what's wired to the backend.

## Security, honestly

While the site is *not* archived, there's still no authentication on
the API endpoints themselves — only `admin.html`'s password screen
gates the editing *UI*. Anyone who found `/api/board` directly could
POST to it. Given this is a private link shared with a handful of
family members for a few days at a time, that's an acceptable
tradeoff — just don't post the URL anywhere public, and archive it
(above) when it's not actively being used.
