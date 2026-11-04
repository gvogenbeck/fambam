# FamBam Fantasy Football — deploy notes

This site is now backed by a small shared database, so everyone sees the
same roster board and poll results — not just whoever's browser made the
edit. Here's how to get it live.

## 1. Push to GitHub

Put this whole `fambam` folder (including `api/`, `lib/`, `package.json`, and
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

## 3b. Set the commissioner password

Project → **Settings → Environment Variables** → add `ADMIN_PASSWORD`
with a password of your choosing (something better than the old
`football`), then redeploy. Without it, `admin.html` can't save
anything. See "Security, honestly" below.

## 4. Add your domain

Project → **Domains** → add your domain → follow the DNS instructions
Vercel gives you (usually one CNAME record at your registrar). Free
HTTPS is automatic.

## How the data flows

- Shared backend code lives in `lib/store.js`, **not** inside `api/`.
  Vercel scans `api/` to decide what becomes a Serverless Function and
  drops underscore-prefixed files from the deployed bundle, so a helper
  at `api/_lib.js` works locally but fails in production with
  "Cannot find module". Keep shared modules in `lib/`.
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

Commissioner edits are protected **on the server**. Every write
endpoint except voting (`board`, `settings`, `polls`, `poll-admin`,
`reset`, and snapshot create/visibility/delete) requires the
commissioner password in an `x-admin-key` header, checked against the
`ADMIN_PASSWORD` environment variable. The password is not in any page
source. `admin.html` asks `/api/auth` whether a typed password is
right, then keeps it in `sessionStorage` for that tab only.

- If `ADMIN_PASSWORD` is not set, every commissioner write is refused
  (503) — it fails closed, not open.
- After 10 wrong passwords from one IP in 15 minutes, that IP is
  locked out until the window passes.
- Changing the password: update `ADMIN_PASSWORD` in Vercel and
  redeploy. Any open admin tab gets bounced back to the lock screen
  on its next save.
- Inputs are validated (shape, lengths, ids), and server errors are
  logged rather than echoed to the browser.

What is still open by design: **voting has no login.** A vote is tied
to a random id in the browser's `localStorage`, so someone could vote
again from a private window or another device. That's fine for family
polls; don't use it for anything that really needs to be tamper-proof.
Votes can only go to polls and options that actually exist, and the
count update is a single atomic Redis script, so simultaneous votes
can't skew the tallies.
