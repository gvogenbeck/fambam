const { redis, countsKey, votersKey, readJsonBody, blockIfArchived } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  const body = readJsonBody(req) || {};
  const action = body.action, pollId = body.pollId;
  if(!pollId) return res.status(400).json({ error:'pollId is required' });

  try{
    const cKey = countsKey(pollId), vKey = votersKey(pollId);

    if(action === 'setCounts'){
      const counts = body.counts;
      if(!counts || typeof counts !== 'object'){
        return res.status(400).json({ error:'counts object is required' });
      }
      await redis.del(cKey);
      const fields = Object.keys(counts);
      if(fields.length){
        const payload = {};
        fields.forEach(function(k){ payload[k] = Math.max(0, Number(counts[k]) || 0); });
        await redis.hset(cKey, payload);
      }
      return res.status(200).json({ ok:true });
    }

    if(action === 'clearVotes'){
      await Promise.all([ redis.del(cKey), redis.del(vKey) ]);
      return res.status(200).json({ ok:true });
    }

    res.status(400).json({ error:'Unknown action' });
  }catch(err){
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
