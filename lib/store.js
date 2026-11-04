/* Shared helpers for the /api/* functions.

   This lives OUTSIDE the /api directory on purpose. Vercel scans /api
   to decide what becomes a Serverless Function and excludes
   underscore-prefixed files from the deployed bundle, so a helper kept
   at api/_lib.js resolves fine locally but goes missing in production
   ("Cannot find module './_lib'"). Keeping it in /lib avoids that
   entirely: it is never treated as a route, and normal dependency
   tracing bundles it with every function that requires it. */
const crypto = require('crypto');
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
  return DEFAULT_NAMES.map(function(n){ return { name:n, signed:n==='Garrett', paid:n==='Garrett', discord:false }; });
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
   the HTML). Taking one is a pure read of the live
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

/* ---- commissioner auth --------------------------------------------
   Every write except voting requires the commissioner password, sent
   as an `x-admin-key` header. The password lives ONLY in the Vercel
   env var ADMIN_PASSWORD — never in page source. If that variable is
   missing, writes fail closed (503) rather than silently allowing
   anyone through.

   Failed attempts are counted per IP in Redis; after AUTH_MAX_FAILS
   within AUTH_WINDOW_SECS, that IP is locked out until the window
   expires, so the password can't be brute-forced at API speed. */
const AUTH_MAX_FAILS = 10;
const AUTH_WINDOW_SECS = 15 * 60;

function clientIp(req){
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '');
  return (fwd.split(',')[0] || '').trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function authFailKey(req){ return 'auth_fail:' + clientIp(req); }

/* Compare via SHA-256 digests so the comparison is constant-time and
   the two buffers are always the same length. */
function safeEqual(a, b){
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* Returns true if `candidate` is the commissioner password. Sends the
   error response itself (and returns false) on any failure. */
async function checkPassword(req, res, candidate){
  const expected = process.env.ADMIN_PASSWORD;
  if(!expected){
    res.status(503).json({ error:'Admin password is not configured on the server (set ADMIN_PASSWORD in Vercel).' });
    return false;
  }
  const failKey = authFailKey(req);
  const fails = Number(await redis.get(failKey)) || 0;
  if(fails >= AUTH_MAX_FAILS){
    res.status(429).json({ error:'Too many wrong passwords. Try again in 15 minutes.' });
    return false;
  }
  if(!candidate || !safeEqual(candidate, expected)){
    const n = await redis.incr(failKey);
    if(n === 1) await redis.expire(failKey, AUTH_WINDOW_SECS);
    res.status(401).json({ error:'Wrong or missing commissioner password.', unauthorized:true });
    return false;
  }
  return true;
}

/* Call at the top of any commissioner-only handler. */
async function requireAdmin(req, res){
  const key = req.headers && req.headers['x-admin-key'];
  return checkPassword(req, res, typeof key === 'string' ? key : '');
}

/* Log the real error server-side; give the browser a generic message
   so internal details (hostnames, stack traces) don't leak. */
function serverError(res, err){
  console.error(err);
  res.status(500).json({ error:'Something went wrong on the server. Try again in a moment.' });
}

/* ---- input validation ---------------------------------------------
   The API used to store whatever JSON arrived. These check the shape
   the pages actually rely on, so a malformed write can't break the
   hub for everyone. Each returns an error string, or null if valid. */
const MAX_BODY_CHARS = 100 * 1000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isStr(v, max){ return typeof v === 'string' && v.length <= max; }
function optStr(v, max){ return v === undefined || v === null || isStr(v, max); }
function optBool(v){ return v === undefined || typeof v === 'boolean'; }
function tooBig(body){ return JSON.stringify(body).length > MAX_BODY_CHARS; }

function validateBoard(body){
  if(!Array.isArray(body)) return 'Body must be an array of managers';
  if(body.length > 50) return 'Too many managers (max 50)';
  for(let i = 0; i < body.length; i++){
    const r = body[i];
    if(!r || typeof r !== 'object' || Array.isArray(r)) return 'Manager '+(i+1)+' is not an object';
    if(!isStr(r.name, 80)) return 'Manager '+(i+1)+' needs a name (text, max 80 characters)';
    if(!optBool(r.signed) || !optBool(r.paid) || !optBool(r.discord)) return 'Manager '+(i+1)+' has a non-true/false status field';
  }
  return tooBig(body) ? 'Roster is too large' : null;
}

function validatePolls(body){
  if(!Array.isArray(body)) return 'Body must be an array of polls';
  if(body.length > 50) return 'Too many polls (max 50)';
  const seen = {};
  for(let i = 0; i < body.length; i++){
    const p = body[i];
    if(!p || typeof p !== 'object' || Array.isArray(p)) return 'Poll '+(i+1)+' is not an object';
    if(typeof p.id !== 'string' || !ID_RE.test(p.id)) return 'Poll '+(i+1)+' has an invalid id';
    if(seen[p.id]) return 'Two polls share the id "'+p.id+'"';
    seen[p.id] = true;
    if(!isStr(p.title, 300)) return 'Poll "'+p.id+'" needs a title (max 300 characters)';
    if(!optStr(p.hint, 1000)) return 'Poll "'+p.id+'" has an invalid hint';
    if(!optBool(p.archived)) return 'Poll "'+p.id+'" has an invalid archived flag';
    if(!Array.isArray(p.options) || p.options.length > 20) return 'Poll "'+p.id+'" needs an options list (max 20)';
    const optSeen = {};
    for(let j = 0; j < p.options.length; j++){
      const o = p.options[j];
      if(!o || typeof o.id !== 'string' || !ID_RE.test(o.id)) return 'Poll "'+p.id+'" option '+(j+1)+' has an invalid id';
      if(optSeen[o.id]) return 'Poll "'+p.id+'" has two options with the id "'+o.id+'"';
      optSeen[o.id] = true;
      if(!isStr(o.label, 300)) return 'Poll "'+p.id+'" option '+(j+1)+' needs a label (max 300 characters)';
    }
  }
  return tooBig(body) ? 'Polls are too large' : null;
}

function validateSettings(body){
  if(!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a settings object';
  const keys = Object.keys(body);
  if(keys.length > 40) return 'Too many settings fields';
  for(const k of keys){
    const v = body[k];
    if(typeof v === 'boolean' || typeof v === 'number' || v === null) continue;
    if(typeof v !== 'string') return 'Setting "'+k+'" must be text, a number, or true/false';
    if(v.length > 5000) return 'Setting "'+k+'" is too long';
  }
  if(body.discordUrl && !/^https?:\/\//i.test(body.discordUrl)) return 'Discord link must start with https://';
  return tooBig(body) ? 'Settings are too large' : null;
}

function validateCounts(counts){
  if(!counts || typeof counts !== 'object' || Array.isArray(counts)) return 'counts object is required';
  const keys = Object.keys(counts);
  if(keys.length > 20) return 'Too many options in counts';
  for(const k of keys){
    if(!ID_RE.test(k)) return 'Invalid option id "'+k+'" in counts';
    const n = Number(counts[k]);
    if(!Number.isFinite(n) || n < 0 || n > 100000) return 'Count for "'+k+'" must be a number from 0 to 100000';
  }
  return null;
}

module.exports = {
  redis, getJSON, setJSON, countsKey, votersKey, normalizeCounts, readJsonBody,
  isArchived, blockIfArchived, requireAdmin, checkPassword, serverError,
  validateBoard, validatePolls, validateSettings, validateCounts, ID_RE,
  syncCountsCache, writeCountsCache, clearCountsCache, clearAllCountsCache, getCountsForPolls,
  SNAPSHOTS_INDEX_KEY, snapshotKey, slugId,
  DEFAULT_NAMES, DEFAULT_POLLS, DEFAULT_SETTINGS, defaultBoard
};
