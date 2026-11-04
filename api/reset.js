const { redis, getJSON, setJSON, countsKey, votersKey,
        DEFAULT_POLLS, DEFAULT_SETTINGS, defaultBoard, blockIfArchived, clearAllCountsCache,
        requireAdmin, serverError } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  try{
    if(!(await requireAdmin(req, res))) return;

    const prevPolls = await getJSON('polls', []);
    await Promise.all(prevPolls.map(function(p){
      return Promise.all([ redis.del(countsKey(p.id)), redis.del(votersKey(p.id)) ]);
    }));
    await clearAllCountsCache();

    await setJSON('board', defaultBoard());
    await setJSON('polls', DEFAULT_POLLS);
    await setJSON('settings', DEFAULT_SETTINGS);

    res.status(200).json({ ok:true });
  }catch(err){
    serverError(res, err);
  }
};
