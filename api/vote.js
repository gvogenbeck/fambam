const { redis, getJSON, countsKey, votersKey, normalizeCounts, readJsonBody, blockIfArchived } = require('./_lib');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  const body = readJsonBody(req) || {};
  const pollId = body.pollId, optionId = body.optionId, voterId = body.voterId, remove = !!body.remove;
  if(!pollId || !voterId || (!remove && !optionId)){
    return res.status(400).json({ error:'pollId, voterId, and optionId (unless removing) are required' });
  }

  try{
    /* An archived poll is kept for the record but closed to voting.
       Enforce that here so it holds even against a direct API call. */
    const polls = await getJSON('polls', []);
    const poll = polls.find(function(p){ return p.id === pollId; });
    if(poll && poll.archived){
      return res.status(403).json({ error:'This poll is archived and no longer accepting votes.' });
    }

    const cKey = countsKey(pollId), vKey = votersKey(pollId);
    const prevChoice = await redis.hget(vKey, voterId);

    if(remove){
      if(prevChoice){
        const cur = Number((await redis.hget(cKey, prevChoice)) || 0);
        if(cur > 0) await redis.hincrby(cKey, prevChoice, -1);
        await redis.hdel(vKey, voterId);
      }
    } else if(prevChoice !== optionId){
      if(prevChoice){
        const cur = Number((await redis.hget(cKey, prevChoice)) || 0);
        if(cur > 0) await redis.hincrby(cKey, prevChoice, -1);
      }
      await redis.hincrby(cKey, optionId, 1);
      await redis.hset(vKey, { [voterId]: optionId });
    }

    const raw = await redis.hgetall(cKey);
    res.status(200).json({ counts: normalizeCounts(raw) });
  }catch(err){
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
