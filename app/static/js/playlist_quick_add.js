(function(){
  const btn = document.getElementById('addToPlaylistBtn');
  const modal = document.getElementById('plQuickModal');
  if(!btn || !modal) return;
  const closeBtn = document.getElementById('plQuickClose');
  const selectEl = document.getElementById('plSelect');
  const addBtn = document.getElementById('plAddBtn');
  const msgEl = document.getElementById('plQuickMsg');
  const newTitle = document.getElementById('plQuickNewTitle');
  const createBtn = document.getElementById('plQuickCreate');
  const videoId = (document.getElementById('video-id')||{}).textContent || '';

  function getCookie(name){ const m=document.cookie.match(new RegExp('(?:^|; )'+name.replace(/([.$?*|{}()\[\]\\\/\+^])/g,'\\$1')+'=([^;]*)')); return m?decodeURIComponent(m[1]):undefined; }
  function authHeader(){ const t = localStorage.getItem('token'); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
  function csrfHeader(){ const c = getCookie('csrf_access_token'); return c ? { 'X-CSRF-TOKEN': c } : {}; }
  function jsonHeaders(){ return { 'Content-Type':'application/json', 'Accept':'application/json', ...authHeader(), ...csrfHeader() }; }

  function open(){ modal.classList.remove('hidden'); modal.classList.add('flex'); loadOwned(); }
  function close(){ modal.classList.add('hidden'); modal.classList.remove('flex'); msgEl.textContent=''; }

  async function loadOwned(){
    selectEl.innerHTML = '';
    try{
      // 'personal' now returns all owned playlists (personal + public)
      const r = await fetch('/api/v1/video/playlists?scope=personal&page=1&page_size=200', { headers: { 'Accept':'application/json', ...authHeader() }});
      if(!r.ok){ selectEl.innerHTML = `<option>Failed to load (${r.status})</option>`; return; }
      const data = await r.json();
      const items = data.items || [];
      if(!items.length){ selectEl.innerHTML = `<option value="">No playlists yet</option>`; return; }
      items.forEach(p=>{
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = `${p.title}${p.is_public ? ' (public)':''}`;
        selectEl.appendChild(opt);
      });
    }catch(e){ selectEl.innerHTML = `<option>Load error</option>`; }
  }

  async function addToSelected(){
    msgEl.textContent=''; const pid = selectEl.value; if(!pid){ msgEl.textContent='Select a playlist'; return; }
    const r = await fetch(`/api/v1/video/playlists/${pid}/items`, { method:'POST', headers: jsonHeaders(), body: JSON.stringify({ video_id: videoId }) });
    const data = await r.json().catch(()=>({}));
    if(!r.ok){ msgEl.textContent = data.error || `Error (${r.status})`; return; }
    msgEl.textContent = 'Added'; setTimeout(close, 800);
  }

  async function createAndAdd(){
    msgEl.textContent=''; const title = newTitle.value.trim(); if(!title){ msgEl.textContent='Enter title'; return; }
    const rp = await fetch('/api/v1/video/playlists', { method:'POST', headers: jsonHeaders(), body: JSON.stringify({ title, is_public: false }) });
    const pd = await rp.json().catch(()=>({}));
    if(!rp.ok){ msgEl.textContent = pd.error || `Create failed (${rp.status})`; return; }
    const pid = pd.playlist?.id; if(!pid){ msgEl.textContent = 'Create failed'; return; }
    newTitle.value=''; loadOwned();
    const ri = await fetch(`/api/v1/video/playlists/${pid}/items`, { method:'POST', headers: jsonHeaders(), body: JSON.stringify({ video_id: videoId }) });
    const idd = await ri.json().catch(()=>({}));
    if(!ri.ok){ msgEl.textContent = idd.error || `Add failed (${ri.status})`; return; }
    msgEl.textContent = 'Created and added'; setTimeout(close, 800);
  }

  btn.addEventListener('click', open);
  if(closeBtn) closeBtn.addEventListener('click', close);
  if(addBtn) addBtn.addEventListener('click', addToSelected);
  if(createBtn) createBtn.addEventListener('click', createAndAdd);
  modal.addEventListener('click', (e)=>{ if(e.target === modal) close(); });
})();

