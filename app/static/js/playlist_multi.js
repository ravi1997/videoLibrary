(function(){
  const modal = document.getElementById('plMultiModal');
  if(!modal) return;
  const listEl = document.getElementById('plMultiList');
  const closeBtn = document.getElementById('plMultiClose');
  const saveBtn = document.getElementById('plMultiSave');
  const msgEl = document.getElementById('plMultiMsg');
  let currentVideo = null;

  function getCookie(name){ const m=document.cookie.match(new RegExp('(?:^|; )'+name.replace(/([.$?*|{}()\[\]\\\/\+^])/g,'\\$1')+'=([^;]*)')); return m?decodeURIComponent(m[1]):undefined; }
  function authHeader(){ const t = localStorage.getItem('token'); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
  function csrfHeader(){ const c = getCookie('csrf_access_token'); return c ? { 'X-CSRF-TOKEN': c } : {}; }
  function jsonHeaders(){ return { 'Content-Type':'application/json', 'Accept':'application/json', ...authHeader(), ...csrfHeader() }; }

  function escapeHtml(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;"); }

  async function loadOwned(){
    listEl.innerHTML = `<div class='text-sm muted'>Loading…</div>`;
    try{
      const r = await fetch('/api/v1/video/playlists?scope=personal&page=1&page_size=500', { headers: { 'Accept':'application/json', ...authHeader() }});
      const data = await r.json().catch(()=>({items:[]}));
      const items = data.items || [];
      if(!items.length){ listEl.innerHTML = `<div class='text-sm muted'>No playlists yet. Create one in Playlists.</div>`; return; }
      const frag = document.createDocumentFragment();
      items.forEach(p => {
        const id = p.id;
        const row = document.createElement('label');
        row.className = 'flex items-center gap-2 py-1';
        row.innerHTML = `<input type='checkbox' value='${id}' class='pl-cb'/> <span>${escapeHtml(p.title)} ${p.is_public ? '<span class="badge">public</span>':''}</span>`;
        frag.appendChild(row);
      });
      listEl.replaceChildren(frag);
    } catch {
      listEl.innerHTML = `<div class='text-red-600 text-sm'>Failed to load playlists.</div>`;
    }
  }

  async function save(){
    if(!currentVideo) return;
    msgEl.textContent = '';
    const boxes = Array.from(listEl.querySelectorAll('.pl-cb'));
    const selected = boxes.filter(b => b.checked).map(b => b.value);
    if(!selected.length){ msgEl.textContent = 'Select at least one playlist'; return; }
    let ok = 0, fail = 0;
    for(const pid of selected){
      try{
        const r = await fetch(`/api/v1/video/playlists/${pid}/items`, { method:'POST', headers: jsonHeaders(), body: JSON.stringify({ video_id: currentVideo }) });
        if(r.ok) ok++; else fail++;
      }catch{ fail++; }
    }
    msgEl.textContent = `Saved: ${ok}${fail?`, Failed: ${fail}`:''}`;
    setTimeout(hide, 800);
  }

  function show(videoId){ currentVideo = videoId; modal.classList.remove('hidden'); modal.classList.add('flex'); msgEl.textContent=''; loadOwned(); }
  function hide(){ modal.classList.add('hidden'); modal.classList.remove('flex'); msgEl.textContent=''; currentVideo=null; }

  closeBtn?.addEventListener('click', hide);
  modal.addEventListener('click', (e)=>{ if(e.target === modal) hide(); });
  saveBtn?.addEventListener('click', save);

  window.playlistMulti = { show };
})();

