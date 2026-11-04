/* POST /api/auth { password } — lets admin.html check the commissioner
   password before unlocking its UI. The password itself is only ever
   compared server-side (see checkPassword in lib/store.js); the page
   then sends it as the x-admin-key header on each write. */
const { readJsonBody, checkPassword, serverError } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });

  try{
    const body = readJsonBody(req) || {};
    const password = typeof body.password === 'string' ? body.password : '';
    if(!(await checkPassword(req, res, password))) return;
    res.status(200).json({ ok:true });
  }catch(err){
    serverError(res, err);
  }
};
