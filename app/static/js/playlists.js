(function(){
  const state = { scope:'personal', page:1, pageSize:20, total:0, pages:1 };
  const listEl = document.getElementById('plList');
  const prevBtn = document.getElementById('prevPage');
  const nextBtn = document.getElementById('nextPage');
  const pageInfo = document.getElementById('pageInfo');
  const btnNew = document.getElementById('btnNewPl');
  const form = document.getElementById('newPlForm');
  const tabPersonal = document.getElementById('tabPersonal');
  const tabPublic = document.getElementById('tabPublic');

  function fmtDate(s){ try{ return new Date(s).toLocaleString(); } catch { return s || ''; } }

  function render(items){
    listEl.innerHTML = '';
    if(!items || !items.length){ listEl.innerHTML = '<div class="muted text-sm">No playlists yet.</div>'; }
    items.forEach(p=>{
      const card = document.createElement('div');
      card.className='card flex items-center justify-between gap-2';
      const left = document.createElement('div');
      left.innerHTML = `<div class="font-semibold">${escapeHtml(p.title||'Untitled')}</div>
        <div class="text-xs muted">${p.is_public? 'Public':'Personal'} • ${p.items||0} items • ${fmtDate(p.created_at)}</div>`;
      const right = document.createElement('div');
      right.innerHTML = `<a class="btn btn-primary" href="/playlists/${p.id}">Open</a>`;
      card.appendChild(left); card.appendChild(right);
      listEl.appendChild(card);
    });
    pageInfo.textContent = `Page ${state.page} / ${state.pages}`;
    prevBtn.disabled = state.page<=1; nextBtn.disabled = state.page>=state.pages;
  }

  function getCookie(name){
    const m = document.cookie.match(new RegExp('(?:^|; )'+name.replace(/([.$?*|{}()\[\]\\\/\+^])/g,'\\$1')+'=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : undefined;
  }
  function authHeader(){ const t = localStorage.getItem('token'); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
  function csrfHeader(){ const c = getCookie('csrf_access_token'); return c ? { 'X-CSRF-TOKEN': c } : {}; }
  function jsonHeaders(){ return { 'Content-Type':'application/json', ...authHeader(), ...csrfHeader() }; }

  async function load(){
    const r = await fetch(`/api/v1/video/playlists?scope=${state.scope}&page=${state.page}&page_size=${state.pageSize}`, { headers:{ 'Accept':'application/json', ...authHeader() } });
    if(!r.ok){ listEl.innerHTML = `<div class='text-red-600 text-sm'>Failed to load (${r.status})</div>`; return; }
    const data = await r.json();
    state.total = data.total||0; state.pages = data.pages||1;
    render(data.items||[]);
  }

  function escapeHtml(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;"); }

  // New playlist form
  if(btnNew && form){
    btnNew.addEventListener('click', ()=>{ form.classList.toggle('hidden'); });
    document.getElementById('plCancel').addEventListener('click', ()=>{ form.classList.add('hidden'); });
    document.getElementById('plCreate').addEventListener('click', async ()=>{
      const title = document.getElementById('plTitle').value.trim();
      const description = document.getElementById('plDesc').value.trim();
      const is_public = !!document.getElementById('plPublic').checked;
      const msg = document.getElementById('plMsg');
      msg.textContent='';
      if(!title){ msg.textContent='Title required'; return; }
      const r = await fetch('/api/v1/video/playlists', { method:'POST', headers: jsonHeaders(), body: JSON.stringify({ title, description, is_public }) });
      const data = await r.json().catch(()=>({}));
      if(!r.ok){ msg.textContent = data.error || `Error (${r.status})`; return; }
      form.classList.add('hidden'); document.getElementById('plTitle').value=''; document.getElementById('plDesc').value=''; document.getElementById('plPublic').checked=false;
      // If created a personal pl while on public tab, switch
      state.page = 1; load();
    });
  }

  // Tabs
  function setScope(sc){
    state.scope = sc; state.page = 1;
    tabPersonal.classList.toggle('active', sc==='personal');
    tabPublic.classList.toggle('active', sc==='public');
    load();
  }
  if(tabPersonal) tabPersonal.addEventListener('click', ()=> setScope('personal'));
  if(tabPublic) tabPublic.addEventListener('click', ()=> setScope('public'));

  if(prevBtn) prevBtn.addEventListener('click', ()=> { if(state.page>1){ state.page--; load(); } });
  if(nextBtn) nextBtn.addEventListener('click', ()=> { if(state.page<state.pages){ state.page++; load(); } });

  // Init
  setScope('personal');
})();
