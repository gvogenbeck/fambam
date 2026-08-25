# Reactivating FamBam Fantasy Football for a new season

This site was frozen with `ARCHIVE_MODE=true` at the end of a season.
While archived, every page still loads and shows last year's final
roster and poll results, but nothing can be edited — every write to
the backend (roster changes, poll edits, votes, the admin reset
button) is rejected server-side. Here's how to bring it back.

## 1. Turn editing back on

In the Vercel dashboard → your project → **Settings → Environment
Variables**:

- Find `ARCHIVE_MODE` and either delete it or set its value to `false`.
- Redeploy the project (Vercel usually offers to; if not, go to
  **Deployments** → the latest one → "..." → **Redeploy**).

At this point the site is fully live and editable again, still showing
**last year's** roster and poll data. Everything below is about
getting it ready for the *new* season.

## 2. Decide what to keep

You said you'd want to keep the roster board and polls system, just
with a fresh homepage and new season's content. There are two levels
of "fresh":

**A. Keep the same managers, just clear their status and votes.**
Good if it's the same ten people again. In `admin.html`:
- Click **Clear all switches** to set everyone back to
  not-joined/not-paid.
- For each poll, click **Reset votes** to zero out last year's tallies
  (or **Delete poll** if a question doesn't apply this year, then
  **Add a poll** for new ones).
- Update **League facts** (draft date/time, venue, buy-in) for the
  new season.

**B. Start completely clean.** Click **Reset everything** in
`admin.html`. This wipes the roster, all polls and their votes, and
league facts back to the *hardcoded defaults* in `api/_lib.js` (the
original ten names, the four original polls, the original draft
date). If you want the reset button to seed *different* defaults next
year — a new set of names, new poll questions, a new draft date —
edit the `DEFAULT_NAMES`, `DEFAULT_POLLS`, and `DEFAULT_SETTINGS`
constants near the top of `api/_lib.js` before you redeploy, then hit
reset. That file is the single source of truth both the reset button
and a brand-new (never-visited) deployment fall back to.

Either way, none of this requires touching the frontend code — it's
all done through the `admin.html` UI, backed by the same API.

## 3. Refresh the homepage content

`index.html`'s hero copy, rules section, and wording are all just
static HTML — edit freely for the new season (new draft date in the
prose, updated rules if settings changed, etc.).

The parts that are **wired to the backend and should be left
alone** (structure, not wording) are:
- `<section id="roster">` and the `<div id="boardBody">` inside it —
  this is the live roster board.
- `<section id="vote">` and `<div id="pollHost">` inside it — this is
  where polls render.
- The `<script src="fambam-data.js"></script>` include and the
  `<script>` block below it that calls `DB.load()` and renders
  everything.

As long as those ids and script tags stay in place, you can freely
rewrite everything around them — headlines, the countdown copy, the
rules tables, images, whatever the new season needs.

## 4. Re-freeze at the end of the new season

Same as before: set `ARCHIVE_MODE=true` in Vercel's environment
variables and redeploy. Reads keep working (so the final board and
poll results stay visible), writes get rejected, and the site is safe
to leave sitting online untouched until next year.
