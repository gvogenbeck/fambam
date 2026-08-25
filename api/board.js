const { setJSON, readJsonBody, blockIfArchived } = require('./_lib');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  const body = readJsonBody(req);
  if(!Array.isArray(body)) return res.status(400).json({ error:'Body must be an array of managers' });

  try{
    await setJSON('board', body);
    res.status(200).json({ ok:true });
  }catch(err){
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
