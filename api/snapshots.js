/* /api/snapshots — read and manage frozen season snapshots.
   Snapshot writes (create/setVisibility/delete) are intentionally NOT
   gated by blockIfArchived: archiving the live site freezes editing
   of this season's live data, but taking or managing snapshots is a
   separate action you may still want after that switch is flipped.
   They DO require the commissioner password, archived or not.

   Visibility: the LIST endpoint only returns public snapshots, unless
   the request carries the commissioner password (admin.html does), in
   which case private ones are listed too. Reading a specific ?id=
   always works if you have the id, public or not — hidden from casual
   browsing, still linkable on purpose. */
const {
  redis, getJSON, setJSON, readJsonBody,
  SNAPSHOTS_INDEX_KEY, snapshotKey, slugId,
  getCountsForPolls, DEFAULT_POLLS, DEFAULT_SETTINGS, defaultBoard,
  requireAdmin, serverError, publicBoard
} = require('../lib/store');

const SNAP_ID_RE = /^[a-z0-9-]{1,80}$/;

module.exports = async function handler(req, res) {
  try {
    await route(req, res);
  } catch (err) {
    serverError(res, err);
  }
};

async function route(req, res) {
  if (req.method === 'GET') {
    const id = req.query && req.query.id;

    if (id) {
      if (typeof id !== 'string' || !SNAP_ID_RE.test(id)) { res.status(400).json({ error: 'Invalid snapshot id' }); return; }
      const snap = await getJSON(snapshotKey(id), null);
      if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return; }
      res.status(200).json(snap);
      return;
    }

    /* Private snapshots are only listed for the commissioner. */
    const wantsPrivate = !!(req.headers && req.headers['x-admin-key']);
    if (wantsPrivate && !(await requireAdmin(req, res))) return;

    const rawIndex = (await redis.hgetall(SNAPSHOTS_INDEX_KEY)) || {};
    const list = Object.keys(rawIndex).map(function (sid) {
      let meta;
      try { meta = JSON.parse(rawIndex[sid]); } catch (e) { meta = {}; }
      return Object.assign({ id: sid }, meta);
    }).filter(function (s) {
      return wantsPrivate || s.isPublic;
    }).sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    res.status(200).json({ snapshots: list });
    return;
  }

  if (req.method === 'POST') {
    if (!(await requireAdmin(req, res))) return;

    const body = readJsonBody(req);
    if (!body || !body.action) { res.status(400).json({ error: 'Missing action' }); return; }

    if (body.action === 'create') {
      const label = String(body.label || '').trim().slice(0, 120);
      if (!label) { res.status(400).json({ error: 'A label is required to create a snapshot.' }); return; }

      const id = slugId(label);
      /* never freeze member emails into a snapshot — any ?id= is readable */
      const board = publicBoard(await getJSON('board', defaultBoard()));
      const polls = await getJSON('polls', DEFAULT_POLLS);
      const settings = await getJSON('settings', DEFAULT_SETTINGS);
      const counts = await getCountsForPolls(polls);
      const createdAt = new Date().toISOString();

      /* `content` is reserved for the day page copy moves out of the
         HTML (ROADMAP.md). Empty for now — a snapshot taken today
         just falls back to whatever's hardcoded in season.html at
         render time, same as the live site would have. */
      const snapshot = { id, label, createdAt, isPublic: false, board, polls, counts, settings, content: {} };

      await setJSON(snapshotKey(id), snapshot);
      await redis.hset(SNAPSHOTS_INDEX_KEY, { [id]: JSON.stringify({ label, createdAt, isPublic: false }) });

      res.status(200).json(snapshot);
      return;
    }

    if (body.action === 'setVisibility') {
      const id = body.id;
      if (typeof id !== 'string' || !SNAP_ID_RE.test(id)) { res.status(400).json({ error: 'Missing or invalid snapshot id' }); return; }

      const snap = await getJSON(snapshotKey(id), null);
      if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return; }

      snap.isPublic = !!body.isPublic;
      await setJSON(snapshotKey(id), snap);
      await redis.hset(SNAPSHOTS_INDEX_KEY, {
        [id]: JSON.stringify({ label: snap.label, createdAt: snap.createdAt, isPublic: snap.isPublic })
      });

      res.status(200).json({ id, isPublic: snap.isPublic });
      return;
    }

    if (body.action === 'delete') {
      const id = body.id;
      if (typeof id !== 'string' || !SNAP_ID_RE.test(id)) { res.status(400).json({ error: 'Missing or invalid snapshot id' }); return; }

      await redis.del(snapshotKey(id));
      await redis.hdel(SNAPSHOTS_INDEX_KEY, id);

      res.status(200).json({ deleted: true, id });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
