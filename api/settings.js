const { setJSON, readJsonBody, blockIfArchived, requireAdmin, serverError, validateSettings } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  try{
    if(!(await requireAdmin(req, res))) return;

    const body = readJsonBody(req);
    const invalid = validateSettings(body);
    if(invalid) return res.status(400).json({ error: invalid });

    await setJSON('settings', body);
    res.status(200).json({ ok:true });
  }catch(err){
    serverError(res, err);
  }
};
