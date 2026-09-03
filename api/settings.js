const { setJSON, readJsonBody, blockIfArchived } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  const body = readJsonBody(req);
  if(!body || typeof body !== 'object' || Array.isArray(body)){
    return res.status(400).json({ error:'Body must be a settings object' });
  }

  try{
    await setJSON('settings', body);
    res.status(200).json({ ok:true });
  }catch(err){
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
