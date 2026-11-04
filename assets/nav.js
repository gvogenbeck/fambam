/* Header nav: mobile drawer toggle + dropdown panels. Shared by the public pages. */
(function(){
  "use strict";
  var btn = document.getElementById('navToggle'), nav = document.getElementById('topnav');
  if(!btn || !nav) return;

  btn.addEventListener('click', function(){
    var open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if(!open) closeAll();
  });

  var groups = [];
  Array.prototype.forEach.call(nav.querySelectorAll('.navgroup'), function(g){
    groups.push({ trig: g.querySelector('.navtrig'), panel: g.querySelector('.navpanel') });
  });

  /* The panels use the hidden attribute, which the global
     [hidden]{display:none!important} rule makes reliable even though
     .navpanel sets its own display/position. */
  function setOpen(entry, open){
    entry.trig.setAttribute('aria-expanded', open ? 'true' : 'false');
    entry.panel.hidden = !open;
  }
  function closeAll(except){
    groups.forEach(function(e){ if(e !== except) setOpen(e, false); });
  }

  groups.forEach(function(entry){
    entry.trig.addEventListener('click', function(e){
      e.stopPropagation();
      var open = entry.trig.getAttribute('aria-expanded') === 'true';
      closeAll(entry);
      setOpen(entry, !open);
    });
  });

  /* Click a link: close the panel and, on mobile, the whole drawer. */
  nav.addEventListener('click', function(e){
    if(e.target.closest && e.target.closest('a')){
      closeAll();
      nav.classList.remove('open');
      btn.setAttribute('aria-expanded','false');
    }
  });

  document.addEventListener('click', function(e){
    if(!nav.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeAll();
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){
      closeAll();
      nav.classList.remove('open');
      btn.setAttribute('aria-expanded','false');
    }
  });
})();
