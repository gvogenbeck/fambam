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

  /* "which option did *I* pick" stays local to the browser — there's
     no login system, so the server only needs to track that a given
     voterId has one vote per poll, not surface it back per-visitor */
  function myVoteKey(pollId){ return 'fambam.myvote.'+pollId; }
  function getMyVote(pollId){
    try{ return localStorage.getItem(myVoteKey(pollId)); }catch(e){ return null; }
  }
  function setMyVote(pollId, optionId){
    try{ localStorage.setItem(myVoteKey(pollId), optionId); }catch(e){}
  }

  async function api(path, opts){
    var res = await fetch('/api/'+path, opts);
    var data = null;
    try{ data = await res.json(); }catch(e){}
    if(!res.ok){
      throw new Error((data && data.error) || ('Request to '+path+' failed with status '+res.status));
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

  var MOUNTAIN_OFFSET = '-06:00'; /* MDT, in effect through early Nov */

  window.FamBam = {
    /* lifecycle */
    load: load,
    refresh: load,
    isLoaded: function(){ return loaded; },
    isArchived: function(){ return !!cache.archived; },

    /* helpers */
    esc: esc,
    slug: slug,
    uniqueId: uniqueId,
    draftDate: function(){
      var iso = (cache.settings && cache.settings.draftISO) || '';
      if(!iso) return null;
      var s = iso.length === 16 ? iso + ':00' : iso;
      return new Date(s + MOUNTAIN_OFFSET);
    },

    /* getters — read the in-memory cache populated by load()/refresh() */
    getBoard: function(){ return cache.board; },
    getPolls: function(){ return cache.polls; },
    getCounts: function(pollId){ return (cache.counts && cache.counts[pollId]) || {}; },
    getSettings: function(){ return cache.settings; },
    getMyVote: getMyVote,

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
      try{ localStorage.removeItem(myVoteKey(pollId)); }catch(e){}
      return cache.counts[pollId];
    },
    setCounts: async function(pollId, counts){
      await postJSON('poll-admin', { action:'setCounts', pollId:pollId, counts:counts });
      cache.counts[pollId] = counts;
    },
    clearPollData: async function(pollId){
      await postJSON('poll-admin', { action:'clearVotes', pollId:pollId });
      cache.counts[pollId] = {};
      try{ localStorage.removeItem(myVoteKey(pollId)); }catch(e){}
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

    defaults: {
      names: ['Garrett','Ethan','Henri','Emmett','Brennan','Cade','James','Dirk','David','Brielle']
    }
  };
})();
