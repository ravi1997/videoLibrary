(function(){
  const root = document.querySelector('[data-pid]');
  if(!root) return;
  const pid = root.getAttribute('data-pid');
  const titleHdr = document.getElementById('plTitleHdr');
  const titleInput = document.getElementById('titleInput');
  const descInput = document.getElementById('descInput');
  const publicToggle = document.getElementById('publicToggle');
  const saveMeta = document.getElementById('saveMeta');
  const deletePl = document.getElementById('deletePl');
  const metaMsg = document.getElementById('metaMsg');
  const addVideoId = document.getElementById('addVideoId');
  const addBtn = document.getElementById('addVideoBtn');
  const addMsg = document.getElementById('addMsg');
  const itemsList = document.getElementById('itemsList');
  const saveOrderBtn = document.getElementById('saveOrder');
  const orderMsg = document.getElementById('orderMsg');
  const prevBtn = document.getElementById('prevItems');
  const nextBtn = document.getElementById('nextItems');
  const pageInfo = document.getElementById('itemsPageInfo');
  const state = { page:1, pageSize:50, pages:1, total:0, order:[] };
  let canEdit = false; let pl = null; let editing = false;

  function escapeHtml(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;"); }

  function roles(){ try{ return (JSON.parse(localStorage.getItem('user'))?.roles||[]).map(r=>String(r).toLowerCase()); }catch{return [];} }
  function uid(){ try{ return JSON.parse(localStorage.getItem('user'))?.id || null; } catch { return null; } }

  function getCookie(name){
    const m = document.cookie.match(new RegExp('(?:^|; )'+name.replace(/([.$?*|{}()\[\]\\\/\+^])/g,'\\$1')+'=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : undefined;
  }
  function authHeader(){ const t = localStorage.getItem('token'); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
  function csrfHeader(){ const c = getCookie('csrf_access_token'); return c ? { 'X-CSRF-TOKEN': c } : {}; }
  function jsonHeaders(){ return { 'Content-Type':'application/json', 'Accept':'application/json', ...authHeader(), ...csrfHeader() }; }

  async function loadMeta(){
    const r = await fetch(`/api/v1/video/playlists/${pid}`, { headers:{ 'Accept':'application/json', ...authHeader() } });
    if(!r.ok){ titleHdr.textContent = `Playlist (${r.status})`; return; }
    const data = await r.json();
    pl = data.playlist; if(!pl) return;
    titleHdr.textContent = escapeHtml(pl.title||'Playlist');
    titleInput.value = pl.title||''; descInput.value = pl.description||''; publicToggle.checked = !!pl.is_public;
    const userId = uid();
    const rs = new Set(roles());
    canEdit = (pl.owner_id && userId && String(pl.owner_id)===String(userId)) || rs.has('admin') || rs.has('superadmin');
    // Start in view mode; only enable editing when toggle pressed and canEdit
    setEditing(false);
  }

  function setEditing(on){
    editing = !!on;
    const enable = editing && canEdit;
    [titleInput, descInput, publicToggle, saveMeta, deletePl, addVideoId, addBtn, saveOrderBtn].forEach(el=> el && (el.disabled = !enable && (el===saveMeta||el===deletePl||el===titleInput||el===descInput||el===publicToggle)));
    const tgl = document.getElementById('toggleEdit'); if(tgl){ tgl.disabled = !canEdit; tgl.textContent = enable ? 'Done' : 'Edit'; }
  }

  async function saveMetaFn(){
    metaMsg.textContent='';
    const body = { title: titleInput.value.trim(), description: descInput.value.trim(), is_public: !!publicToggle.checked };
    const r = await fetch(`/api/v1/video/playlists/${pid}`, { method:'PUT', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await r.json().catch(()=>({}));
    if(!r.ok){ metaMsg.textContent = data.error || `Error (${r.status})`; return; }
    metaMsg.textContent = 'Saved';
    loadMeta();
  }

  async function deleteFn(){
    if(!confirm('Delete this playlist?')) return;
    const r = await fetch(`/api/v1/video/playlists/${pid}`, { method:'DELETE', headers: { ...authHeader(), ...csrfHeader() }});
    if(!r.ok){ metaMsg.textContent = `Delete failed (${r.status})`; return; }
    window.location.assign('/playlists');
  }

  function renderItems(items){
    itemsList.innerHTML=''; state.order = [];
    if(!items || !items.length){ itemsList.innerHTML='<div class="muted text-sm">No items.</div>'; }
    items.forEach((it, idx)=>{
      state.order.push(it.video_id);
      const row = document.createElement('div');
      row.className = 'card flex items-center justify-between gap-2';
      row.dataset.videoId = it.video_id;
      const left = document.createElement('div');
      left.innerHTML = `<div class="font-semibold truncate">${escapeHtml(it.video?.title||it.video_id)}</div>
        <div class="text-xs muted">${it.position} • ${escapeHtml(it.video_id)}</div>`;
      const right = document.createElement('div');
      const up = document.createElement('button'); up.className='btn btn-ghost'; up.textContent='↑';
      const down = document.createElement('button'); down.className='btn btn-ghost'; down.textContent='↓';
      const del = document.createElement('button'); del.className='btn btn-danger'; del.textContent='Remove';
      [up,down,del].forEach(b=> b.disabled = !canEdit);
      up.addEventListener('click', ()=> move(idx, -1));
      down.addEventListener('click', ()=> move(idx, +1));
      del.addEventListener('click', ()=> removeItem(it.video_id));
      right.appendChild(up); right.appendChild(down); right.appendChild(del);
      row.appendChild(left); row.appendChild(right);
      itemsList.appendChild(row);
    });
    pageInfo.textContent = `Page ${state.page} / ${state.pages}`;
    prevBtn.disabled = state.page<=1; nextBtn.disabled = state.page>=state.pages;
  }

  function move(index, delta){
    const newIndex = index + delta; if(newIndex<0 || newIndex>=state.order.length) return;
    const tmp = state.order[index]; state.order[index] = state.order[newIndex]; state.order[newIndex] = tmp;
    // Re-render simple move visually
    const nodes = Array.from(itemsList.children);
    if(nodes[index] && nodes[newIndex]){
      if(delta<0) itemsList.insertBefore(nodes[index], nodes[newIndex]);
      else itemsList.insertBefore(nodes[newIndex], nodes[index]);
    }
  }

  async function loadItems(){
    const r = await fetch(`/api/v1/video/playlists/${pid}/items?page=${state.page}&page_size=${state.pageSize}`, { headers:{ 'Accept':'application/json', ...authHeader() } });
    if(!r.ok){ itemsList.innerHTML = `<div class='text-red-600 text-sm'>Failed to load items (${r.status})</div>`; return; }
    const data = await r.json();
    state.total = data.total||0; state.pages = data.pages||1;
    renderItems(data.items||[]);
  }

  async function saveOrder(){
    orderMsg.textContent='';
    const r = await fetch(`/api/v1/video/playlists/${pid}/reorder`, { method:'POST', headers: jsonHeaders(), body: JSON.stringify({ order: state.order }) });
    const data = await r.json().catch(()=>({}));
    if(!r.ok){ orderMsg.textContent = data.error || `Error (${r.status})`; return; }
    orderMsg.textContent = 'Order saved';
    loadItems();
  }

  async function removeItem(videoId){
    if(!confirm('Remove item?')) return;
    const r = await fetch(`/api/v1/video/playlists/${pid}/items/${encodeURIComponent(videoId)}`, { method:'DELETE', headers: { ...authHeader(), ...csrfHeader() }});
    if(!r.ok){ orderMsg.textContent = `Remove failed (${r.status})`; return; }
    loadItems();
  }

  async function addItem(){
    addMsg.textContent='';
    const vid = addVideoId.value.trim(); if(!vid){ addMsg.textContent='Enter video UUID'; return; }
    const r = await fetch(`/api/v1/video/playlists/${pid}/items`, { method:'POST', headers: jsonHeaders(), body: JSON.stringify({ video_id: vid }) });
    const data = await r.json().catch(()=>({}));
    if(!r.ok){ addMsg.textContent = data.error || `Error (${r.status})`; return; }
    addVideoId.value=''; addMsg.textContent='Added';
    loadItems();
  }

  if(saveMeta) saveMeta.addEventListener('click', saveMetaFn);
  const toggleBtn = document.getElementById('toggleEdit');
  if(toggleBtn) toggleBtn.addEventListener('click', ()=> setEditing(!editing));
  if(deletePl) deletePl.addEventListener('click', deleteFn);
  if(addBtn) addBtn.addEventListener('click', addItem);
  if(saveOrderBtn) saveOrderBtn.addEventListener('click', saveOrder);
  if(prevBtn) prevBtn.addEventListener('click', ()=>{ if(state.page>1){ state.page--; loadItems(); } });
  if(nextBtn) nextBtn.addEventListener('click', ()=>{ if(state.page<state.pages){ state.page++; loadItems(); } });

  // Init
  loadMeta().then(loadItems);
})();
