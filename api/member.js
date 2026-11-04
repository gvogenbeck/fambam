/* /api/member — league-member sign-in by magic link.

   GET                              -> { member: {name,email}|null, myVotes: {pollId: optionId} }
   POST { action:'request', email } -> emails a one-time sign-in link
   POST { action:'redeem', token }  -> trades that link's token for a session cookie
   POST { action:'logout' }         -> ends this browser's session

   The link points at the hub (index.html#signin=<token>) rather than
   at this endpoint, and the hub POSTs the token here. That's on purpose:
   corporate mail scanners (Outlook Safe Links and friends) pre-fetch
   every GET link in an email, which would burn a one-time token before
   the person ever clicked it. A scanner won't run the page's script.

   Email goes out through Resend's HTTP API (no SDK needed). Set
   RESEND_API_KEY and MAIL_FROM in Vercel; SITE_URL is strongly
   recommended so links never depend on the request's Host header.
   See README.md. */
const {
  redis, getJSON, readJsonBody, isArchived, serverError, clientIp,
  EMAIL_RE, SESSION_TTL_SECS, MAGIC_TTL_SECS,
  normEmail, isMembersPoll, memberVoterId, newToken, magicKey, sessionKey,
  sessionCookie, findMember, currentMember, overLimit, votersKey, parseCookies, SESSION_COOKIE
} = require('../lib/store');

const SENT_MESSAGE = 'If that email is on the league roster, a sign-in link is on its way. ' +
  'It works once and expires in 20 minutes. Not seeing it? Check spam, or ask the commissioner which email they have for you.';

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  try{
    if(req.method === 'GET') return await status(req, res);
    if(req.method !== 'POST') return res.status(405).json({ error:'GET or POST only' });

    const body = readJsonBody(req) || {};
    if(body.action === 'request') return await requestLink(req, res, body);
    if(body.action === 'redeem') return await redeem(req, res, body);
    if(body.action === 'logout') return await logout(req, res);
    res.status(400).json({ error:'Unknown action' });
  }catch(err){
    serverError(res, err);
  }
};

async function status(req, res){
  const board = await getJSON('board', []);
  const m = await currentMember(req, board);
  if(!m) return res.status(200).json({ member:null, myVotes:{} });

  const polls = (await getJSON('polls', [])).filter(isMembersPoll);
  const voter = memberVoterId(m.email);
  const picks = await Promise.all(polls.map(function(p){ return redis.hget(votersKey(p.id), voter); }));
  const myVotes = {};
  polls.forEach(function(p, i){ if(picks[i]) myVotes[p.id] = String(picks[i]); });

  res.status(200).json({ member:{ name:m.name, email:m.email }, myVotes:myVotes });
}

function siteBase(req){
  const fixed = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if(fixed) return fixed;
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  const proto = String(h['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return proto + '://' + host;
}

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function sendEmail(to, name, link){
  const greeting = name ? 'Hey ' + name + ',' : 'Hey,';
  const text = greeting + '\n\nTap this link to sign in and vote on the FamBam polls:\n\n' + link +
    '\n\nIt works once and expires in 20 minutes. If you didn\'t ask for this, you can ignore it.\n';
  const html =
    '<p>' + escHtml(greeting) + '</p>' +
    '<p>Tap the button to sign in and vote on the FamBam Fantasy Football polls.</p>' +
    '<p><a href="' + escHtml(link) + '" style="display:inline-block;background:#FB4F14;color:#0A0A0A;' +
      'padding:12px 20px;text-decoration:none;font-weight:bold">Sign in to vote</a></p>' +
    '<p style="color:#666;font-size:13px">It works once and expires in 20 minutes. ' +
      'If you didn\'t ask for this, you can ignore it.</p>';

  const r = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ 'Authorization':'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to:[to], subject:'Your FamBam sign-in link', text:text, html:html })
  });
  if(!r.ok){
    let detail = '';
    try{ detail = await r.text(); }catch(e){}
    throw new Error('Resend rejected the email (' + r.status + '): ' + detail.slice(0, 500));
  }
}

async function requestLink(req, res, body){
  if(isArchived()) return res.status(403).json({ error:'This site is archived for the season — voting is closed.', archived:true });
  if(!process.env.RESEND_API_KEY || !process.env.MAIL_FROM){
    return res.status(503).json({ error:'Email sign-in isn\'t set up on the server yet (the commissioner needs to add RESEND_API_KEY and MAIL_FROM).' });
  }

  const email = normEmail(body.email);
  if(!email || email.length > 254 || !EMAIL_RE.test(email)){
    return res.status(400).json({ error:'Enter a valid email address.' });
  }

  if(await overLimit('signin_ip:' + clientIp(req), 10, 15 * 60)){
    return res.status(429).json({ error:'Too many sign-in requests. Try again in 15 minutes.' });
  }
  /* Quietly cap per address too, so nobody can flood a member's inbox.
     Same response either way, to avoid revealing who's on the roster. */
  if(await overLimit('signin_email:' + email, 3, 15 * 60)){
    return res.status(200).json({ ok:true, message:SENT_MESSAGE });
  }

  const board = await getJSON('board', []);
  const m = findMember(board, email);
  if(m){
    const token = newToken();
    await redis.set(magicKey(token), email, { ex: MAGIC_TTL_SECS });
    const link = siteBase(req) + '/index.html#signin=' + encodeURIComponent(token);
    try{
      await sendEmail(email, m.name, link);
    }catch(err){
      console.error(err);
      return res.status(502).json({ error:'Couldn\'t send the email just now. Try again in a minute.' });
    }
  }
  res.status(200).json({ ok:true, message:SENT_MESSAGE });
}

async function redeem(req, res, body){
  const token = typeof body.token === 'string' ? body.token : '';
  if(!token || token.length > 200) return res.status(400).json({ error:'That sign-in link is incomplete.' });
  if(await overLimit('redeem_ip:' + clientIp(req), 20, 15 * 60)){
    return res.status(429).json({ error:'Too many attempts. Try again in 15 minutes.' });
  }

  /* GETDEL makes the link single-use even if two tabs race to redeem it */
  const email = await redis.getdel(magicKey(token));
  if(typeof email !== 'string' || !email){
    return res.status(400).json({ error:'That sign-in link has expired or was already used. Request a new one.', expired:true });
  }

  const board = await getJSON('board', []);
  const m = findMember(board, email);
  if(!m) return res.status(403).json({ error:'That email is no longer on the league roster.' });

  const sid = newToken();
  await redis.set(sessionKey(sid), normEmail(email), { ex: SESSION_TTL_SECS });
  res.setHeader('Set-Cookie', sessionCookie(sid, SESSION_TTL_SECS));
  res.status(200).json({ ok:true, member:{ name:m.name || '', email:normEmail(email) } });
}

async function logout(req, res){
  const sid = parseCookies(req)[SESSION_COOKIE];
  if(sid && sid.length <= 200) await redis.del(sessionKey(sid));
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  res.status(200).json({ ok:true });
}
