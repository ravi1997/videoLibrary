(() => {
  const BASE = '/video';
  const token = () => localStorage.getItem('token') || '';
  const headers = () => ({ 'Accept': 'application/json', 'Authorization': `Bearer ${token()}` });
  const sQ = id => document.getElementById(id);
  const surgeonList = sQ('surgeonList');
  const userList = sQ('userList');
  let selSurgeon = null; let selUser = null;
  const bulk = { surgeonIds: new Set() };

  const state = {
    surgeons: { page:1, pages:1, pageSize:20, filter:'', q:'', sort:'id', dir:'desc' },
  users: { page:1, pages:1, pageSize:20, filter:'', q:'', sort:'created_at', dir:'desc' }
  };

  function activateSeg(group, btn){
  group.querySelectorAll('.seg').forEach(b => b.classList.remove('active','bg-[color:var(--brand-600)]','text-white','dark:bg-[color:var(--brand-500)]'));
  btn.classList.add('active','bg-[color:var(--brand-600)]','text-white','dark:bg-[color:var(--brand-500)]');
  }

  function wireSegmentedControls(){
    const sLinkGroup = sQ('surgeonLinkedGroup');
    sLinkGroup?.addEventListener('click', e => {
      const btn = e.target.closest('.seg'); if(!btn) return;
      activateSeg(sLinkGroup, btn);
      state.surgeons.filter = btn.dataset.val || '';
      state.surgeons.page = 1; searchSurgeons();
    });

    const sPageGroup = sQ('surgeonPageSizeGroup');
    sPageGroup?.addEventListener('click', e => {
      const btn = e.target.closest('.seg'); if(!btn) return;
      activateSeg(sPageGroup, btn);
      state.surgeons.pageSize = +btn.dataset.size;
      state.surgeons.page = 1; searchSurgeons();
    });

    const uLinkGroup = sQ('userLinkedGroup');
    uLinkGroup?.addEventListener('click', e => {
      const btn = e.target.closest('.seg'); if(!btn) return;
      activateSeg(uLinkGroup, btn);
      state.users.filter = btn.dataset.val || '';
      state.users.page = 1; searchUsers();
    });

    const uPageGroup = sQ('userPageSizeGroup');
    uPageGroup?.addEventListener('click', e => {
      const btn = e.target.closest('.seg'); if(!btn) return;
      activateSeg(uPageGroup, btn);
      state.users.pageSize = +btn.dataset.size;
      state.users.page = 1; searchUsers();
    });
  }

  function applySortStyles(groupEl, currentKey, dir){
    groupEl.querySelectorAll('.sort-btn').forEach(btn => {
      const key = btn.dataset.key;
      const arrow = btn.querySelector('.sort-arrow');
      if(key === currentKey){
        btn.classList.add('bg-[color:var(--brand-600)]','text-white','dark:bg-[color:var(--brand-500)]');
        arrow.classList.remove('opacity-40');
        arrow.textContent = dir === 'asc' ? '↑' : '↓';
      } else {
        btn.classList.remove('bg-[color:var(--brand-600)]','text-white','dark:bg-[color:var(--brand-500)]');
        arrow.classList.add('opacity-40');
        arrow.textContent = '↕';
      }
    });
  }

  // Attach sorting behavior to surgeon & user sort button groups
  function wireSortGroups(){
    const sGroup = sQ('surgeonSortGroup');
    if(sGroup){
      applySortStyles(sGroup, state.surgeons.sort, state.surgeons.dir);
      sGroup.addEventListener('click', e => {
        const btn = e.target.closest('.sort-btn');
        if(!btn) return;
        const key = btn.dataset.key;
        if(state.surgeons.sort === key){
          state.surgeons.dir = state.surgeons.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.surgeons.sort = key;
          state.surgeons.dir = 'asc';
        }
        applySortStyles(sGroup, state.surgeons.sort, state.surgeons.dir);
        searchSurgeons();
      });
    }
    const uGroup = sQ('userSortGroup');
    if(uGroup){
      applySortStyles(uGroup, state.users.sort, state.users.dir);
      uGroup.addEventListener('click', e => {
        const btn = e.target.closest('.sort-btn');
        if(!btn) return;
        const key = btn.dataset.key;
        if(state.users.sort === key){
          state.users.dir = state.users.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.users.sort = key;
          state.users.dir = 'asc';
        }
        applySortStyles(uGroup, state.users.sort, state.users.dir);
        searchUsers();
      });
    }
  }

  async function fetchJSON(url, opts={}){
    const bar = document.getElementById('globalLoading');
    bar && bar.classList.remove('hidden');
    try {
      const r = await fetch(url, { headers: headers(), ...opts });
      if(!r.ok) throw new Error(await r.text()||r.status);
      return r.json();
    } finally {
      setTimeout(() => { bar && bar.classList.add('hidden'); }, 120); // slight delay for smoother perception
    }
  }
  function renderList(el, items, type){
    el.replaceChildren();
    if(!items.length){
      const empty = document.createElement('li');
      empty.className = 'py-8 text-center text-xs uppercase tracking-wide text-[color:var(--muted)]';
      empty.textContent = type==='surgeon' ? 'No surgeons found' : 'No users found';
      el.appendChild(empty);
      return;
    }
    items.forEach(it => {
      const li = document.createElement('li');
      const selected = bulk.surgeonIds.has(it.id) && type==='surgeon';
  li.className = 'group py-2 px-2 hover:bg-[color:var(--brand-50)] dark:hover:bg-[color:var(--brand-900)]/40 cursor-pointer flex justify-between items-center transition-colors rounded-md ' + (selected ? 'bg-[color:var(--brand-100)] dark:bg-[color:var(--brand-900)]' : '');
  li.dataset.id = it.id;
      if(type==='surgeon'){
        li.innerHTML = `<span class=\"flex items-center gap-2\"><input type=\"checkbox\" class=\"bulkChk accent-[color:var(--brand-600)]\" data-id=\"${it.id}\" ${selected?'checked':''}/><span class=\"truncate\">${escapeHtml(it.name)} <span class=\\"muted text-xs\\">(${escapeHtml(it.type||'')})</span></span></span><span class=\"text-[10px] uppercase tracking-wide ${it.user_id ? 'text-green-600 dark:text-green-400':'text-red-600 dark:text-red-400'}\">${it.user_id ? 'linked':'unlinked'}</span>`;
        li.addEventListener('click', (e) => { if(e.target.classList.contains('bulkChk')) return; selSurgeon = it; updatePanel(); highlightSelection(); });
      } else {
        li.innerHTML = `<span class=\"flex items-center gap-2\"><input type=\"radio\" name=\"userSelect\" class=\"userPick accent-[color:var(--brand-600)]\" data-id=\"${it.id}\" ${selUser && selUser.id===it.id ? 'checked':''}/><span class=\"truncate\">${escapeHtml(it.username||'')} <span class=\\"muted text-xs\\">${escapeHtml(it.email||'')}</span></span></span><span class=\"text-[10px] uppercase tracking-wide ${it.has_surgeon ? 'text-yellow-600 dark:text-yellow-400':''}\">${it.has_surgeon ? 'has':'no'} surgeon</span>`;
        li.addEventListener('click', (e) => { if(e.target.classList.contains('userPick')) return; selUser = it; updatePanel(); highlightSelection(); syncUserRadios(); });
      }
      el.appendChild(li);
    });
    if(type==='surgeon'){
      el.querySelectorAll('.bulkChk').forEach(chk => {
        chk.addEventListener('change', e => {
          const id = parseInt(e.target.getAttribute('data-id'));
          if(e.target.checked) bulk.surgeonIds.add(id); else bulk.surgeonIds.delete(id);
          syncMasterChk();
          updateBulkStatus();
        });
      });
      syncMasterChk();
    } else {
      syncUserRadios();
    }
  }
  function syncUserRadios(){
    const radios = userList.querySelectorAll('.userPick');
    radios.forEach(r => { r.checked = selUser && selUser.id === parseInt(r.dataset.id); });
  }
  function syncMasterChk(){
    const master = sQ('surgeonMasterChk');
    if(!master) return;
    const boxes = surgeonList.querySelectorAll('.bulkChk');
    const total = boxes.length;
    const checked = Array.from(boxes).filter(b => b.checked).length;
    master.indeterminate = checked>0 && checked<total;
    master.checked = total>0 && checked===total;
  }
  function selectAllPage(){
    surgeonList.querySelectorAll('.bulkChk').forEach(chk => { chk.checked = true; bulk.surgeonIds.add(parseInt(chk.dataset.id)); });
    syncMasterChk(); updateBulkStatus();
  }
  function clearAllPage(){
    surgeonList.querySelectorAll('.bulkChk').forEach(chk => { chk.checked = false; bulk.surgeonIds.delete(parseInt(chk.dataset.id)); });
    syncMasterChk(); updateBulkStatus();
  }
  function invertSelection(){
    surgeonList.querySelectorAll('.bulkChk').forEach(chk => {
      const id = parseInt(chk.dataset.id);
      if(chk.checked){ chk.checked=false; bulk.surgeonIds.delete(id); }
      else { chk.checked=true; bulk.surgeonIds.add(id); }
    });
    syncMasterChk(); updateBulkStatus();
  }
  function updateBulkStatus(){
    const el = sQ('bulkStatus');
    if(el) el.textContent = bulk.surgeonIds.size ? `${bulk.surgeonIds.size} selected` : '';
  }
  function highlightSelection(){
    // Clear previous highlight
    Array.from(surgeonList.children).forEach(li => li.classList.remove('ring','ring-[color:var(--brand-600)]','selected-row','bg-[color:var(--brand-200)]','dark:bg-[color:var(--brand-800)]'));
    if(selSurgeon){
      const el = surgeonList.querySelector(`[data-id='${selSurgeon.id}']`);
      if(el) el.classList.add('ring','ring-[color:var(--brand-600)]','selected-row','bg-[color:var(--brand-200)]','dark:bg-[color:var(--brand-800)]');
    }
    Array.from(userList.children).forEach(li => li.classList.remove('ring','ring-[color:var(--brand-600)]','selected-row','bg-[color:var(--brand-200)]','dark:bg-[color:var(--brand-800)]'));
    if(selUser){
      const el = userList.querySelector(`[data-id='${selUser.id}']`);
      if(el) el.classList.add('ring','ring-[color:var(--brand-600)]','selected-row','bg-[color:var(--brand-200)]','dark:bg-[color:var(--brand-800)]');
    }
  }
  function updatePanel(){
    const panel = sQ('linkPanel');
    const sSpan = sQ('selSurgeon');
    const uSpan = sQ('selUser');
    const sDesc = sQ('selSurgeonDesc');
    if(selSurgeon) sSpan.textContent = selSurgeon.name; else sSpan.textContent = '—';
    if(selUser) uSpan.textContent = selUser.username || '—'; else uSpan.textContent = '—';
    sDesc && (sDesc.textContent = selSurgeon?.description || '');
    // Panel should show if either side selected
    panel.hidden = !(selSurgeon || selUser);
    if(selSurgeon){
      if(selSurgeon.user_id){ loadSurgeonDetail(selSurgeon.id); } else hideSurgeonUser();
    } else hideSurgeonUser();
    if(selUser){ loadUserSurgeons(selUser.id); } else hideUserSurgeons();
  }
  function hideSurgeonUser(){ const box = sQ('selSurgeonUser'); if(box){ box.classList.add('hidden'); } }
  function hideUserSurgeons(){ const box = sQ('selUserSurgeons'); if(box){ box.classList.add('hidden'); } }

  async function loadSurgeonDetail(id){
    try{
      const data = await fetchJSON(`${BASE}/api/v1/admin/surgeons/${id}/detail`);
      if(data.user){
        const box = sQ('selSurgeonUser');
        if(box){
          sQ('surgeonUserName').textContent = data.user.username;
            sQ('surgeonUserEmail').textContent = data.user.email;
          box.classList.remove('hidden');
        }
      } else hideSurgeonUser();
    }catch(e){ hideSurgeonUser(); }
  }
  async function loadUserSurgeons(uid){
    try{
      const data = await fetchJSON(`${BASE}/api/v1/admin/users/${uid}/surgeons`);
      const box = sQ('selUserSurgeons');
      if(!box) return;
      const list = sQ('userSurgeonsList');
      list.replaceChildren();
      (data.surgeons||[]).forEach(s => {
        const li = document.createElement('li');
        li.className = 'px-2 py-1 flex items-center justify-between gap-2';
        li.innerHTML = `<span class=\"truncate\">${escapeHtml(s.name)} <span class=\\"muted text-[10px]\\">(${escapeHtml(s.type||'')})</span></span><button class=\"unlinkSurgeon btn btn-ghost px-2 py-0.5 text-[10px]\" data-id=\"${s.id}\">Unlink</button>`;
        list.appendChild(li);
      });
      sQ('userSurgeonCount').textContent = (data.surgeons||[]).length;
      box.classList.remove('hidden');
      // wire inline unlink buttons
      list.querySelectorAll('.unlinkSurgeon').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const sid = btn.getAttribute('data-id');
          try{
            const r = await fetch(`${BASE}/api/v1/admin/surgeons/${sid}/unlink`, { method:'POST', headers: headers() });
            if(!r.ok) throw new Error();
            toast('Unlinked');
            if(selSurgeon && selSurgeon.id == sid){ selSurgeon.user_id = null; }
            await searchSurgeons();
            await loadUserSurgeons(uid); // refresh list
            highlightSelection();
          }catch(err){ toast('Inline unlink failed','error'); }
        });
      });
    }catch(e){ hideUserSurgeons(); }
  }
  async function searchSurgeons(){
  state.surgeons.q = (sQ('surgeonSearch').value||'').trim();
    const {q, filter, page, pageSize, sort, dir} = state.surgeons;
    const url = `${BASE}/api/v1/admin/surgeons?q=${encodeURIComponent(q)}&linked=${filter}&page=${page}&page_size=${pageSize}&sort_by=${sort}&sort_dir=${dir}`;
    try{ const data = await fetchJSON(url); renderList(surgeonList, data.items || [], 'surgeon'); updateSurgeonMeta(data);}catch(e){ console.error(e); }
  }
  async function searchUsers(){
  state.users.q = (sQ('userSearch').value||'').trim();
    const {q, filter, page, pageSize, sort, dir} = state.users;
    const url = `${BASE}/api/v1/admin/users?q=${encodeURIComponent(q)}&has_surgeon=${filter}&page=${page}&page_size=${pageSize}&sort_by=${sort}&sort_dir=${dir}`;
    try{ const data = await fetchJSON(url); renderList(userList, data.items || [], 'user'); updateUserMeta(data);}catch(e){ console.error(e); }
  }
  async function link(){
    if(!(selSurgeon && selUser)) return;
    try{
      const r = await fetch(`${BASE}/api/v1/admin/surgeons/${selSurgeon.id}/link`, { method:'POST', headers:{...headers(),'Content-Type':'application/json'}, body: JSON.stringify({ user_id: selUser.id }) });
      if(!r.ok) throw new Error(r.status);
      selSurgeon.user_id = selUser.id; updatePanel(); searchSurgeons();
  await searchSurgeons();
  await searchUsers();
  highlightSelection();
  toast('Linked');
    }catch(e){ toast('Link failed','error'); }
  }
  async function unlink(){
    if(!selSurgeon) return;
    try{
      const r = await fetch(`${BASE}/api/v1/admin/surgeons/${selSurgeon.id}/unlink`, { method:'POST', headers: headers() });
      if(!r.ok) throw new Error(r.status);
  selSurgeon.user_id = null; updatePanel();
  await searchSurgeons();
  await searchUsers();
  highlightSelection();
  toast('Unlinked');
    }catch(e){ toast('Unlink failed','error'); }
  }
  async function bulkLink(){
    if(!bulk.surgeonIds.size || !selUser){ toast('Select surgeons and a user','warn'); return; }
    try {
      const body = { surgeon_ids: Array.from(bulk.surgeonIds), user_id: selUser.id };
      const r = await fetch(BASE + '/api/v1/admin/surgeons/bulk/link', { method:'POST', headers:{...headers(),'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if(!r.ok) throw new Error();
  await searchSurgeons();
  await searchUsers();
  highlightSelection();
  toast('Bulk linked');
    }catch(e){ toast('Bulk link failed','error'); }
  }
  async function bulkUnlink(){
    if(!bulk.surgeonIds.size){ toast('Select surgeons','warn'); return; }
    try {
      const body = { surgeon_ids: Array.from(bulk.surgeonIds) };
      const r = await fetch(BASE + '/api/v1/admin/surgeons/bulk/unlink', { method:'POST', headers:{...headers(),'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if(!r.ok) throw new Error();
  await searchSurgeons();
  await searchUsers();
  highlightSelection();
  toast('Bulk unlinked');
    }catch(e){ toast('Bulk unlink failed','error'); }
  }
  function clearSel(){ selSurgeon=null; selUser=null; updatePanel(); highlightSelection(); }

  function updateSurgeonMeta(data){
    state.surgeons.pages = data.pages; const info = sQ('surgeonPageInfo');
    if(info) info.textContent = `Page ${data.page} / ${data.pages}`;
    const stats = sQ('surgeonStats');
    if(stats){
      const filterLabel = state.surgeons.filter === '' ? 'All' : (state.surgeons.filter === 'yes' ? 'Linked' : 'Unlinked');
      stats.textContent = `${data.total} total • ${data.counts.linked} linked • ${data.counts.unlinked} unlinked • Filter: ${filterLabel}`;
    }
  }
  function updateUserMeta(data){
    state.users.pages = data.pages; const info = sQ('userPageInfo');
    if(info) info.textContent = `Page ${data.page} / ${data.pages}`;
    const stats = sQ('userStats');
    if(stats){
      const filterLabel = state.users.filter === '' ? 'All' : (state.users.filter === 'yes' ? 'With' : 'Without');
      stats.textContent = `${data.total} total • ${data.counts.with} with surgeon • ${data.counts.without} without • Filter: ${filterLabel}`;
    }
  }

  function changeSurgeonPage(delta){ state.surgeons.page = Math.min(Math.max(1, state.surgeons.page + delta), state.surgeons.pages); searchSurgeons(); }
  function changeUserPage(delta){ state.users.page = Math.min(Math.max(1, state.users.page + delta), state.users.pages); searchUsers(); }

  async function createSurgeon(){
    const name = (sQ('newName').value||'').trim();
    const type = (sQ('newType').value||'').trim();
    const description = (sQ('newDesc').value||'').trim();
    if(!name || !type){ toast('Name & type required','warn'); return; }
    try{
      const r = await fetch(BASE + '/api/v1/admin/surgeons', { method:'POST', headers:{...headers(),'Content-Type':'application/json'}, body: JSON.stringify({name, type, description}) });
      if(!r.ok) throw new Error(r.status);
      sQ('newName').value=''; sQ('newType').value=''; sQ('newDesc').value='';
      toast('Surgeon created');
      searchSurgeons();
    }catch(e){ toast('Create failed','error'); }
  }

  function toast(msg,type='info'){ if(window.showToast) window.showToast(msg,type,3000); else console.log(msg); }
  function escapeHtml(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

  function init(){
    sQ('surgeonSearchBtn')?.addEventListener('click', () => { state.surgeons.page=1; searchSurgeons(); });
    sQ('userSearchBtn')?.addEventListener('click', () => { state.users.page=1; searchUsers(); });
    sQ('surgeonPrev')?.addEventListener('click', () => changeSurgeonPage(-1));
    sQ('surgeonNext')?.addEventListener('click', () => changeSurgeonPage(1));
    sQ('userPrev')?.addEventListener('click', () => changeUserPage(-1));
    sQ('userNext')?.addEventListener('click', () => changeUserPage(1));
    sQ('createSurgeonBtn')?.addEventListener('click', createSurgeon);
    sQ('bulkLinkBtn')?.addEventListener('click', bulkLink);
    sQ('bulkUnlinkBtn')?.addEventListener('click', bulkUnlink);
    sQ('linkBtn')?.addEventListener('click', link);
    sQ('unlinkBtn')?.addEventListener('click', unlink);
    sQ('clearSel')?.addEventListener('click', clearSel);
    // inline unlink for surgeon detail box
    document.addEventListener('click', e => {
      const btn = e.target.closest('#surgeonInlineUnlink');
      if(btn && selSurgeon){
        unlink();
      }
    });
    const master = sQ('surgeonMasterChk');
    master?.addEventListener('change', e => { e.target.checked ? selectAllPage() : clearAllPage(); });
    sQ('invertSelection')?.addEventListener('click', invertSelection);
    sQ('surgeonSelectAll')?.addEventListener('click', selectAllPage);
    sQ('surgeonClearSel')?.addEventListener('click', clearAllPage);
    wireSortGroups();
    wireSegmentedControls();
    searchSurgeons();
    searchUsers();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
