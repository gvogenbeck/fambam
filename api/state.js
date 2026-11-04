const { getJSON, setJSON, getCountsForPolls,
        DEFAULT_POLLS, DEFAULT_SETTINGS, defaultBoard, isArchived, serverError,
        requireAdmin, publicBoard } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'GET') return res.status(405).json({ error:'GET only' });

  try{
    /* Member emails are private: only the commissioner (who sends the
       password header, like admin.html does) gets them back. A wrong
       password here is a 401, same as any other admin call. */
    const wantsPrivate = !!(req.headers && req.headers['x-admin-key']);
    if(wantsPrivate && !(await requireAdmin(req, res))) return;

    let board = await getJSON('board', null);
    if(!board){ board = defaultBoard(); await setJSON('board', board); }

    let polls = await getJSON('polls', null);
    if(!polls){ polls = DEFAULT_POLLS; await setJSON('polls', polls); }

    let settings = await getJSON('settings', null);
    if(!settings){ settings = DEFAULT_SETTINGS; await setJSON('settings', settings); }

    const counts = await getCountsForPolls(polls);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ board: wantsPrivate ? board : publicBoard(board), polls: polls, settings: settings, counts: counts, archived: isArchived() });
  }catch(err){
    serverError(res, err);
  }
};
