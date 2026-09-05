/* Shared helpers for the /api/* functions.

   This lives OUTSIDE the /api directory on purpose. Vercel scans /api
   to decide what becomes a Serverless Function and excludes
   underscore-prefixed files from the deployed bundle, so a helper kept
   at api/_lib.js resolves fine locally but goes missing in production
   ("Cannot find module './_lib'"). Keeping it in /lib avoids that
   entirely: it is never treated as a route, and normal dependency
   tracing bundles it with every function that requires it. */
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const DEFAULT_NAMES = ['Garrett','Ethan','Henri','Emmett','Brennan','Cade','James','Dirk','David','Brielle'];

const DEFAULT_POLLS = [
  { id:'fee', title:'Entry fee', hint:'Pot is 10× the buy-in — how it splits depends on which fee wins.',
    options:[
      {id:'10', label:'$10 — winner take all $100'},
      {id:'15', label:'$15 — pays $120 / $30'},
      {id:'20', label:'$20 — pays $120 / $60 / $20'}
    ]},
  { id:'playoffs', title:'Playoff format', hint:'Currently set to 6 teams, Weeks 15–17 (the current default). Switching to 4 drops the Week 15 playoff round.',
    options:[
      {id:'6', label:'Top 6 of 10 — current format, top two seeds get a bye'},
      {id:'4', label:'Top 4 of 10 — regular season matters more'}
    ]},
  { id:'scoring', title:'Scoring format', hint:'Currently 0.5 PPR. Full PPR pays more for catches; Standard drops reception points entirely.',
    options:[
      {id:'standard', label:'Standard — no points per reception'},
      {id:'half', label:'0.5 PPR — the happy middle'},
      {id:'full', label:'Full PPR — 1 point per reception'}
    ]},
  { id:'goat', title:'Greatest QB of all time', hint:'The debate no one asked for. Choose wisely.',
    options:[
      {id:'mahomes', label:'Patrick Mahomes'},
      {id:'manning', label:'Peyton Manning'},
      {id:'montana', label:'Joe Montana'},
      {id:'rodgers', label:'Aaron Rodgers'}
    ]}
];

const DEFAULT_SETTINGS = {
  draftISO:'2026-09-05T16:00',
  draftLabel:'Sat, Sept 5 — Afternoon',
  venue:'The Mayhaks — Family Dinner',
  entryFee:'$10',
  payout:'$100 — Winner takes all',
  scoring:'0.5 PPR',
  /* Empty until the invite exists. The hub treats a blank value as
     "not ready yet" and shows a disabled chip rather than a dead link. */
  discordUrl:'',
  /* Off by default. announceText is compared as plain text against
     what each browser has already seen (see index.html), so editing
     the message is what makes it resurface — flipping announceOn off
     and back on with the same text will not. */
  announceOn:false,
  announceText:''
};

function defaultBoard(){
  return DEFAULT_NAMES.map(function(n){ return { name:n, signed:n==='Garrett', paid:n==='Garrett' }; });
}

/* Read/write JSON blobs as plain strings, so behavior doesn't depend
   on which Redis client version's auto-(de)serialization is active. */
async function getJSON(key, fallback){
  const raw = await redis.get(key);
  if(raw === null || raw === undefined) return fallback;
  if(typeof raw === 'string'){
    try{ return JSON.parse(raw); }catch(e){ return fallback; }
  }
  return raw; /* SDK already parsed it into an object */
}
async function setJSON(key, value){
  await redis.set(key, JSON.stringify(value));
}

function countsKey(pollId){ return 'poll:'+pollId+':counts'; }
function votersKey(pollId){ return 'poll:'+pollId+':voters'; }

/* ---- season snapshots ---------------------------------------------
   A snapshot is a frozen copy of board/polls/counts/settings (plus a
   `content` field reserved for later, once page copy moves out of
   the HTML — see ROADMAP.md). Taking one is a pure read of the live
   keys; it never writes back to them. snapshot:<id> holds the full
   object; SNAPSHOTS_INDEX_KEY is a hash of id -> small metadata
   (label/createdAt/isPublic) so listing doesn't require loading every
   full snapshot just to show a table of them. */
const SNAPSHOTS_INDEX_KEY = 'snapshots_index';
function snapshotKey(id){ return 'snapshot:'+id; }

/* Slug the label for readability, then suffix with a base36 timestamp
   so ids are unique without needing to check existing keys first. */
function slugId(s){
  const base = String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
  return (base || 'season') + '-' + Date.now().toString(36);
}

const ARCHIVE_MESSAGE = 'This site is archived for the season — editing is turned off. See REACTIVATE.md to bring it back for a new year.';

function isArchived(){
  return String(process.env.ARCHIVE_MODE || '').toLowerCase() === 'true';
}

/* Call at the top of any write-capable handler. Returns true (and
   already sent the response) if the request was blocked. */
function blockIfArchived(res){
  if(isArchived()){
    res.status(403).json({ error: ARCHIVE_MESSAGE, archived: true });
    return true;
  }
  return false;
}

function normalizeCounts(obj){
  const out = {};
  Object.keys(obj || {}).forEach(function(k){ out[k] = Number(obj[k]) || 0; });
  return out;
}

function readJsonBody(req){
  /* Vercel's Node runtime auto-parses JSON bodies into req.body when
     Content-Type is application/json, but guard for the rare case
     it arrives as a raw string. */
  if(req.body && typeof req.body === 'object') return req.body;
  if(typeof req.body === 'string'){
    try{ return JSON.parse(req.body); }catch(e){ return null; }
  }
  return null;
}

/* ---- vote count cache -----------------------------------------------
   The per-poll Redis hashes (poll:<id>:counts) are the source of truth
   and are what vote.js atomically increments/decrements — that part is
   unchanged. But /api/state gets called far more often than anyone
   votes (the hub polls it in the background), and reading every poll's
   hash separately means that read cost scales with how many polls
   exist. ALL_COUNTS_KEY is a single Redis hash — one field per poll,
   each holding that poll's counts as a JSON string — kept in sync by
   every write path below. Reading it is one command no matter how
   many polls there are. HSET on a single field is atomic, so writes
   to different polls' cache entries can't race with each other. */
const ALL_COUNTS_KEY = 'all_counts';

/* Re-reads a poll's authoritative hash and writes the cache entry to
   match. Use this after a write when you don't already know the exact
   resulting counts (e.g. after an increment). Returns the normalized
   counts so callers can reuse them instead of reading twice. */
async function syncCountsCache(pollId){
  const raw = await redis.hgetall(countsKey(pollId));
  const norm = normalizeCounts(raw);
  await redis.hset(ALL_COUNTS_KEY, { [pollId]: JSON.stringify(norm) });
  return norm;
}

/* Writes a known counts object straight into the cache, skipping the
   extra hash read — use this when the caller already knows the exact
   values it just wrote (e.g. an admin's manual count override). */
async function writeCountsCache(pollId, counts){
  await redis.hset(ALL_COUNTS_KEY, { [pollId]: JSON.stringify(normalizeCounts(counts)) });
}

async function clearCountsCache(pollId){
  await redis.hdel(ALL_COUNTS_KEY, pollId);
}

async function clearAllCountsCache(){
  await redis.del(ALL_COUNTS_KEY);
}

/* Reads the whole cache in one command. Any poll missing from it (a
   poll that predates this cache, or one that was just created) gets
   its hash read directly and the cache backfilled on the spot — so
   the very first read after this feature ships costs a little more
   for whichever polls haven't been cached yet, and every read after
   that is back to one command. */
async function getCountsForPolls(polls){
  const rawAll = await redis.hgetall(ALL_COUNTS_KEY) || {};
  const counts = {};
  const missing = [];
  polls.forEach(function(p){
    if(Object.prototype.hasOwnProperty.call(rawAll, p.id)){
      try{ counts[p.id] = JSON.parse(rawAll[p.id]); }
      catch(e){ missing.push(p.id); }
    } else {
      missing.push(p.id);
    }
  });
  if(missing.length){
    await Promise.all(missing.map(async function(pollId){
      counts[pollId] = await syncCountsCache(pollId);
    }));
  }
  return counts;
}

module.exports = {
  redis, getJSON, setJSON, countsKey, votersKey, normalizeCounts, readJsonBody,
  isArchived, blockIfArchived,
  syncCountsCache, writeCountsCache, clearCountsCache, clearAllCountsCache, getCountsForPolls,
  SNAPSHOTS_INDEX_KEY, snapshotKey, slugId,
  DEFAULT_NAMES, DEFAULT_POLLS, DEFAULT_SETTINGS, defaultBoard
};
