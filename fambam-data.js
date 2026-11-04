/* FamBam Fantasy Football — shared data layer, server-backed.
   Talks to the /api/* serverless functions, which store data in a
   shared Redis instance so every visitor sees the same roster,
   polls, and settings — not just their own browser.

   Call DB.load() once before your first render; after that, the
   getters read a small in-memory cache synchronously. Every setter
   writes through to the server first, then updates that cache. */
(function(){
  "use strict";

  var cache = { board: [], polls: [], settings: {}, counts: {}, archived: false };
  /* the signed-in league member (or null) and their picks on
     members-only polls — those live on the server, not in this browser */
  var member = { member: null, myVotes: {} };
  var loaded = false;

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function slug(s){
    var base = String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,28);
    return base || 'item-' + Math.random().toString(36).slice(2,7);
  }
  function uniqueId(base, taken){
    var id = slug(base), n = 2;
    while(taken.indexOf(id) !== -1){ id = slug(base)+'-'+n; n++; }
    return id;
  }

  /* a per-browser id, so the server knows "you already voted on this
     poll" and can move your vote instead of double-counting it */
  function voterId(){
    var k = 'fambam.voterId', id = null;
    try{ id = localStorage.getItem(k); }catch(e){}
    if(!id){
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
        'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10);
      try{ localStorage.setItem(k, id); }catch(e){}
    }
    return id;
  }

  /* "which option did *I* pick". On anonymous polls this stays local
     to the browser; the server only tracks that a voterId has one vote.
     On members-only polls the server is the source of truth (it follows
     the member across devices), loaded by loadMember(). */
  function myVoteKey(pollId){ return 'fambam.myvote.'+pollId; }
  function findPoll(pollId){
    return (cache.polls || []).find(function(p){ return p.id === pollId; }) || null;
  }
  function isMembersPoll(p){ return !!p && p.voting === 'members'; }
  function getMyVote(pollId){
    if(isMembersPoll(findPoll(pollId))) return member.myVotes[pollId] || null;
    try{ return localStorage.getItem(myVoteKey(pollId)); }catch(e){ return null; }
  }
  function setMyVote(pollId, optionId){
    if(isMembersPoll(findPoll(pollId))){
      if(optionId) member.myVotes[pollId] = optionId; else delete member.myVotes[pollId];
      return;
    }
    try{
      if(optionId) localStorage.setItem(myVoteKey(pollId), optionId);
      else localStorage.removeItem(myVoteKey(pollId));
    }catch(e){}
  }

  async function loadMember(){
    var data = await api('member');
    member.member = (data && data.member) || null;
    member.myVotes = (data && data.myVotes) || {};
    return member.member;
  }

  /* The commissioner password, held for this tab only (sessionStorage)
     once admin.html has verified it with /api/auth. Sent as a header
     on every request; the server is what actually checks it. */
  var ADMIN_KEY = 'fambam.admin.key';
  function getAdminKey(){
    try{ return sessionStorage.getItem(ADMIN_KEY) || ''; }catch(e){ return ''; }
  }
  function setAdminKey(k){
    try{ if(k) sessionStorage.setItem(ADMIN_KEY, k); else sessionStorage.removeItem(ADMIN_KEY); }catch(e){}
  }

  async function api(path, opts){
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var key = getAdminKey();
    if(key) headers['x-admin-key'] = key;
    var res = await fetch('/api/'+path, Object.assign({}, opts, { headers: headers }));
    var data = null;
    try{ data = await res.json(); }catch(e){}
    if(!res.ok){
      if(res.status === 401){
        /* stale or wrong password — forget it and let the page re-lock */
        setAdminKey('');
        try{ window.dispatchEvent(new CustomEvent('fambam:unauthorized')); }catch(e){}
      }
      var err = new Error((data && data.error) || ('Request to '+path+' failed with status '+res.status));
      err.status = res.status;
      err.data = data || {};
      throw err;
    }
    return data;
  }
  function postJSON(path, body){
    return api(path, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(body)
    });
  }

  async function load(){
    var data = await api('state');
    cache.board = data.board || [];
    cache.polls = data.polls || [];
    cache.settings = data.settings || {};
    cache.counts = data.counts || {};
    cache.archived = !!data.archived;
    loaded = true;
    return cache;
  }

  /* League time zone. draftISO is a wall-clock time ("2026-09-05T16:00")
     in this zone; the UTC offset is worked out for that specific date
     so daylight saving (MDT -6 / MST -7) is always right. */
  var LEAGUE_TZ = 'America/Denver';

  /* Offset of tz from UTC, in minutes, at the given instant. */
  function tzOffsetMinutes(tz, date){
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'
    }).formatToParts(date);
    var v = {};
    parts.forEach(function(p){ v[p.type] = Number(p.value); });
    var asUTC = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  }

  /* Interpret a "YYYY-MM-DDTHH:MM[:SS]" wall-clock time as being in tz. */
  function zonedTime(iso, tz){
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
    if(!m) return null;
    var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    /* two passes so a guess that lands across a DST change self-corrects */
    var off = tzOffsetMinutes(tz, new Date(guess));
    off = tzOffsetMinutes(tz, new Date(guess - off * 60000));
    return new Date(guess - off * 60000);
  }

  window.FamBam = {
    /* lifecycle */
    load: load,
    refresh: load,
    isLoaded: function(){ return loaded; },
    isArchived: function(){ return !!cache.archived; },

    /* commissioner auth — verifyAdmin asks the server; on success the
       password is remembered for this tab and sent with each write */
    verifyAdmin: async function(password){
      setAdminKey('');
      await postJSON('auth', { password: password });
      setAdminKey(password);
    },
    hasAdminKey: function(){ return !!getAdminKey(); },
    forgetAdmin: function(){ setAdminKey(''); },

    /* helpers */
    esc: esc,
    slug: slug,
    uniqueId: uniqueId,
    draftDate: function(){
      var iso = (cache.settings && cache.settings.draftISO) || '';
      if(!iso) return null;
      try{ return zonedTime(iso, LEAGUE_TZ); }
      catch(e){ return null; }
    },

    /* getters — read the in-memory cache populated by load()/refresh() */
    getBoard: function(){ return cache.board; },
    getPolls: function(){ return cache.polls; },
    getCounts: function(pollId){ return (cache.counts && cache.counts[pollId]) || {}; },
    getSettings: function(){ return cache.settings; },
    getMyVote: getMyVote,
    isMembersPoll: function(pollId){ return isMembersPoll(findPoll(pollId)); },

    /* league-member sign-in (magic link) */
    loadMember: loadMember,
    getMember: function(){ return member.member; },
    requestSignIn: function(email){ return postJSON('member', { action:'request', email:email }); },
    redeemSignIn: async function(token){
      var data = await postJSON('member', { action:'redeem', token:token });
      await loadMember();
      return data.member;
    },
    signOut: async function(){
      await postJSON('member', { action:'logout' });
      member.member = null;
      member.myVotes = {};
    },

    /* setters — write through to the server, then update the cache */
    setBoard: async function(rows){
      await postJSON('board', rows);
      cache.board = rows;
    },
    setSettings: async function(s){
      await postJSON('settings', s);
      cache.settings = s;
    },
    setPolls: async function(polls){
      await postJSON('polls', polls);
      cache.polls = polls;
      var keep = {};
      polls.forEach(function(p){ keep[p.id] = cache.counts[p.id] || {}; });
      cache.counts = keep;
    },
    castVote: async function(pollId, choice){
      if(getMyVote(pollId) === choice) return this.removeVote(pollId);
      var data = await postJSON('vote', { pollId:pollId, optionId:choice, voterId:voterId() });
      cache.counts[pollId] = data.counts || {};
      setMyVote(pollId, choice);
      return cache.counts[pollId];
    },
    removeVote: async function(pollId){
      var data = await postJSON('vote', { pollId:pollId, remove:true, voterId:voterId() });
      cache.counts[pollId] = data.counts || {};
      setMyVote(pollId, null);
      return cache.counts[pollId];
    },
    /* commissioner: who voted for what on a members-only poll */
    getVoters: async function(pollId){
      var data = await postJSON('poll-admin', { action:'voters', pollId:pollId });
      return (data && data.voters) || [];
    },
    setCounts: async function(pollId, counts){
      await postJSON('poll-admin', { action:'setCounts', pollId:pollId, counts:counts });
      cache.counts[pollId] = counts;
    },
    clearPollData: async function(pollId){
      await postJSON('poll-admin', { action:'clearVotes', pollId:pollId });
      cache.counts[pollId] = {};
      try{ localStorage.removeItem(myVoteKey(pollId)); }catch(e){}
      delete member.myVotes[pollId];
    },

    /* backup / restore */
    exportAll: function(){
      var votes = {};
      (cache.polls||[]).forEach(function(p){ votes[p.id] = cache.counts[p.id] || {}; });
      return { exported:new Date().toISOString(), board:cache.board, polls:cache.polls, votes:votes, settings:cache.settings };
    },
    importAll: async function(data){
      if(!data || typeof data !== 'object') throw new Error('That is not valid league data.');
      if(Array.isArray(data.board)) await this.setBoard(data.board);
      if(Array.isArray(data.polls)) await this.setPolls(data.polls);
      if(data.settings) await this.setSettings(data.settings);
      if(data.votes){
        var ids = Object.keys(data.votes);
        for(var i=0;i<ids.length;i++){ await this.setCounts(ids[i], data.votes[ids[i]]); }
      }
      await load();
    },
    resetEverything: async function(){
      await api('reset', { method:'POST' });
      await load();
    },

    /* season snapshots — frozen copies, independent of the live cache
       above. These don't touch `cache`, since a snapshot is a separate
       read: it's never "the current state," even right after it's taken. */
    listSnapshots: function(){ return api('snapshots'); },
    getSnapshot: function(id){ return api('snapshots?id='+encodeURIComponent(id)); },
    createSnapshot: function(label){ return postJSON('snapshots', { action:'create', label:label }); },
    setSnapshotVisibility: function(id, isPublic){
      return postJSON('snapshots', { action:'setVisibility', id:id, isPublic:!!isPublic });
    },
    deleteSnapshot: function(id){ return postJSON('snapshots', { action:'delete', id:id }); },

    defaults: {
      names: ['Garrett','Ethan','Henri','Emmett','Brennan','Cade','James','Dirk','David','Brielle']
    }
  };
})();
