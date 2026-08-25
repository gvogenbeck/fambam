/* Shared helpers for the /api/* functions. Not routable itself —
   files starting with an underscore are excluded from Vercel's
   Serverless Functions, but can still be require()'d normally. */
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
  entryFee:'TBD — vote below'
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

module.exports = {
  redis, getJSON, setJSON, countsKey, votersKey, normalizeCounts, readJsonBody,
  isArchived, blockIfArchived,
  DEFAULT_NAMES, DEFAULT_POLLS, DEFAULT_SETTINGS, defaultBoard
};
