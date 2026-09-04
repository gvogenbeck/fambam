const { getJSON, setJSON, getCountsForPolls,
        DEFAULT_POLLS, DEFAULT_SETTINGS, defaultBoard, isArchived } = require('../lib/store');

module.exports = async function handler(req, res){
  if(req.method !== 'GET') return res.status(405).json({ error:'GET only' });

  try{
    let board = await getJSON('board', null);
    if(!board){ board = defaultBoard(); await setJSON('board', board); }

    let polls = await getJSON('polls', null);
    if(!polls){ polls = DEFAULT_POLLS; await setJSON('polls', polls); }

    let settings = await getJSON('settings', null);
    if(!settings){ settings = DEFAULT_SETTINGS; await setJSON('settings', settings); }

    const counts = await getCountsForPolls(polls);

    res.status(200).json({ board: board, polls: polls, settings: settings, counts: counts, archived: isArchived() });
  }catch(err){
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
