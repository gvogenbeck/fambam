const { redis, countsKey, votersKey, readJsonBody, blockIfArchived, writeCountsCache,
        requireAdmin, serverError, validateCounts, ID_RE } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  try{
    if(!(await requireAdmin(req, res))) return;

    const body = readJsonBody(req) || {};
    const action = body.action, pollId = body.pollId;
    if(typeof pollId !== 'string' || !ID_RE.test(pollId)) return res.status(400).json({ error:'A valid pollId is required' });

    const cKey = countsKey(pollId), vKey = votersKey(pollId);

    if(action === 'setCounts'){
      const counts = body.counts;
      const invalid = validateCounts(counts);
      if(invalid) return res.status(400).json({ error: invalid });
      await redis.del(cKey);
      const fields = Object.keys(counts);
      const payload = {};
      if(fields.length){
        fields.forEach(function(k){ payload[k] = Math.floor(Number(counts[k])); });
        await redis.hset(cKey, payload);
      }
      await writeCountsCache(pollId, payload);
      return res.status(200).json({ ok:true });
    }

    if(action === 'clearVotes'){
      await Promise.all([ redis.del(cKey), redis.del(vKey) ]);
      await writeCountsCache(pollId, {});
      return res.status(200).json({ ok:true });
    }

    res.status(400).json({ error:'Unknown action' });
  }catch(err){
    serverError(res, err);
  }
};
