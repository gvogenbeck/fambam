const { getJSON, setJSON, normEmail, readJsonBody, blockIfArchived, requireAdmin, serverError, validateBoard } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  if(blockIfArchived(res)) return;

  try{
    if(!(await requireAdmin(req, res))) return;

    const body = readJsonBody(req);
    const invalid = validateBoard(body);
    if(invalid) return res.status(400).json({ error: invalid });

    /* A row that has no `email` key at all (an old backup being
       imported, say) keeps whatever email that name had before, so
       restoring a pre-email export doesn't silently sign everyone
       out of members-only polls. An explicit '' still clears it. */
    const prev = await getJSON('board', []);
    const rows = body.map(function(r){
      const out = Object.assign({}, r);
      if(out.email === undefined){
        const old = prev.find(function(p){ return p.email && p.name === r.name; });
        if(old) out.email = old.email;
      }
      if(typeof out.email === 'string') out.email = normEmail(out.email);
      if(!out.email) delete out.email;
      return out;
    });
    const dup = validateBoard(rows);
    if(dup) return res.status(400).json({ error: dup });

    await setJSON('board', rows);
    res.status(200).json({ ok:true });
  }catch(err){
    serverError(res, err);
  }
};
