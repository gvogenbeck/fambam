const { redis, getJSON, countsKey, votersKey, readJsonBody, blockIfArchived, syncCountsCache,
        serverError, ID_RE } = require('../lib/store');

/* Moves/adds/removes one voter's vote in a single atomic step. Done as
   a Lua script so two votes landing at the same moment can't interleave
   their read-then-write steps and leave the tallies off by one.
   KEYS[1] = counts hash, KEYS[2] = voters hash
   ARGV[1] = voterId, ARGV[2] = optionId, ARGV[3] = '1' to remove */
const VOTE_SCRIPT = `
local prev = redis.call('HGET', KEYS[2], ARGV[1])
local function dec(opt)
  local cur = tonumber(redis.call('HGET', KEYS[1], opt) or '0') or 0
  if cur > 0 then redis.call('HINCRBY', KEYS[1], opt, -1) end
end
if ARGV[3] == '1' then
  if prev then
    dec(prev)
    redis.call('HDEL', KEYS[2], ARGV[1])
  end
elseif prev ~= ARGV[2] then
  if prev then dec(prev) end
  redis.call('HINCRBY', KEYS[1], ARGV[2], 1)
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
end
return 1
`;

const VOTER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  const body = readJsonBody(req) || {};
  const pollId = body.pollId, optionId = body.optionId, voterId = body.voterId, remove = !!body.remove;
  if(typeof pollId !== 'string' || !ID_RE.test(pollId) ||
     typeof voterId !== 'string' || !VOTER_ID_RE.test(voterId) ||
     (!remove && (typeof optionId !== 'string' || !ID_RE.test(optionId)))){
    return res.status(400).json({ error:'pollId, voterId, and optionId (unless removing) are required' });
  }

  try{
    /* Only real polls and real options can receive votes — otherwise a
       direct API call could create junk keys in Redis. An archived
       poll is kept for the record but closed to voting. */
    const polls = await getJSON('polls', []);
    const poll = polls.find(function(p){ return p.id === pollId; });
    if(!poll) return res.status(404).json({ error:'That poll no longer exists.' });
    if(poll.archived){
      return res.status(403).json({ error:'This poll is archived and no longer accepting votes.' });
    }
    if(!remove && !(poll.options || []).some(function(o){ return o.id === optionId; })){
      return res.status(400).json({ error:'That option is not part of this poll.' });
    }

    await redis.eval(VOTE_SCRIPT, [countsKey(pollId), votersKey(pollId)], [voterId, remove ? '' : optionId, remove ? '1' : '0']);

    const counts = await syncCountsCache(pollId);
    res.status(200).json({ counts: counts });
  }catch(err){
    serverError(res, err);
  }
};
