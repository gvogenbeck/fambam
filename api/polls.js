const { redis, getJSON, setJSON, countsKey, votersKey, readJsonBody, blockIfArchived,
        clearCountsCache, syncCountsCache } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  const body = readJsonBody(req);
  if(!Array.isArray(body)) return res.status(400).json({ error:'Body must be an array of polls' });

  try{
    const prev = await getJSON('polls', []);

    /* a poll removed entirely — drop its vote hashes and cache entry */
    const nextIds = body.map(function(p){ return p.id; });
    const removedPolls = prev
      .map(function(p){ return p.id; })
      .filter(function(id){ return nextIds.indexOf(id) === -1; });
    await Promise.all(removedPolls.map(function(id){
      return Promise.all([ redis.del(countsKey(id)), redis.del(votersKey(id)), clearCountsCache(id) ]);
    }));

    /* an option removed from a poll that still exists — drop just that
       field, then refresh the cache entry to match */
    await Promise.all(body.map(async function(p){
      const old = prev.find(function(x){ return x.id === p.id; });
      if(!old) return;
      const newOptIds = p.options.map(function(o){ return o.id; });
      const removedOpts = old.options
        .map(function(o){ return o.id; })
        .filter(function(id){ return newOptIds.indexOf(id) === -1; });
      if(removedOpts.length){
        await redis.hdel(countsKey(p.id), ...removedOpts);
        await syncCountsCache(p.id);
      }
    }));

    await setJSON('polls', body);
    res.status(200).json({ ok:true });
  }catch(err){
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
