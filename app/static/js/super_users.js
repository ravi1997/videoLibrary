// Superadmin User Management page logic (externalized for CSP compliance)
(function(){
  const BASE = '/video';
  const tableBody = document.querySelector('#usersTable tbody');
  if(!tableBody) return; // page not present
  const form = document.getElementById('filterForm');
  const paginationBtns = document.getElementById('paginationBtns');
  const paginationInfo = document.getElementById('paginationInfo');
  let currentPage = 1;
  let lastQuery = {};
  const rolesModalEl = document.getElementById('rolesModal');
  let rolesModalOpen = false;
  let editingUserId = null;
  const selected = new Set();
  const confirmModalEl = document.getElementById('confirmModal');
  let confirmModalOpen = false;
  let confirmResolve = null;
  // Verification modal state
  const verifyModalEl = document.getElementById('verifyModal');
  let verifyModalOpen = false;
  let verifyTargetId = null;

  function openModal(){
    if(!rolesModalEl) return;
    rolesModalEl.classList.remove('hidden');
    rolesModalOpen = true;
  }
  function closeModal(){
    if(!rolesModalEl) return;
    rolesModalEl.classList.add('hidden');
    rolesModalOpen = false;
  }
  function openConfirm({title, message, okText='Confirm', cancelText='Cancel'}){
    if(!confirmModalEl) return Promise.resolve(false);
    const titleEl = confirmModalEl.querySelector('#confirmTitle');
    const msgEl = confirmModalEl.querySelector('#confirmMessage');
    if(titleEl) titleEl.textContent = title;
    if(msgEl) msgEl.textContent = message;
    const okBtn = confirmModalEl.querySelector('[data-confirm-ok]');
    const cancelBtn = confirmModalEl.querySelector('[data-confirm-cancel]');
    if(okBtn) okBtn.textContent = okText;
    if(cancelBtn) cancelBtn.textContent = cancelText;
    confirmModalEl.classList.remove('hidden');
    confirmModalOpen = true;
    return new Promise(res=>{ confirmResolve = res; });
  }
  function closeConfirm(result){
    if(!confirmModalEl) return;
    confirmModalEl.classList.add('hidden');
    confirmModalOpen = false;
    if(confirmResolve){ confirmResolve(result); confirmResolve = null; }
  }
  if(confirmModalEl){
    confirmModalEl.addEventListener('click', e=>{
      if(e.target.matches('[data-modal-dismiss], [data-modal-dismiss] *') || e.target === confirmModalEl){
        closeConfirm(false);
      }
      if(e.target.matches('[data-confirm-ok]')) closeConfirm(true);
      if(e.target.matches('[data-confirm-cancel]')) closeConfirm(false);
    });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape' && confirmModalOpen) closeConfirm(false); });
  }
  if(rolesModalEl){
    rolesModalEl.addEventListener('click', e=>{
      if(e.target.matches('[data-modal-dismiss], [data-modal-dismiss] *') || e.target === rolesModalEl){
        closeModal();
      }
    });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape' && rolesModalOpen) closeModal(); });
  }

  function authHeader(){
    const token = localStorage.getItem('access_token');
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  function getCookie(name){
    const m = document.cookie.match(new RegExp('(?:^|; )'+name.replace(/([.$?*|{}()\[\]\\\/\+^])/g,'\\$1')+'=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : undefined;
  }

  function csrfHeader(){
    const csrf = getCookie('csrf_access_token');
    return csrf ? { 'X-CSRF-TOKEN': csrf } : {};
  }

  function jsonHeaders(){
    return { 'Content-Type':'application/json', ...authHeader(), ...csrfHeader() };
  }

  async function fetchUsers(page=1){
    const loading = document.getElementById('tableLoading');
    const emptyState = document.getElementById('emptyState');
    if(loading){
      loading.classList.remove('hidden');
      loading.classList.add('flex');
    }
    const fd = new FormData(form);
    fd.set('page', page);
    // Persist sort state in hidden inputs if set via header clicks
    if(!form.querySelector('input[name="sort_by"]')){
      const sb = document.createElement('input'); sb.type='hidden'; sb.name='sort_by'; form.appendChild(sb);
    }
    if(!form.querySelector('input[name="sort_dir"]')){
      const sd = document.createElement('input'); sd.type='hidden'; sd.name='sort_dir'; form.appendChild(sd);
    }
    lastQuery = Object.fromEntries(fd.entries());
    const params = new URLSearchParams(lastQuery).toString();
    const res = await fetch(`${BASE}/api/v1/super/users?${params}`, { headers: { ...authHeader() }});
    if(!res.ok){ console.error('Failed to load users'); if(loading){loading.classList.add('hidden'); loading.classList.remove('flex');} return; }
    const data = await res.json();
    renderUsers(data.items);
    renderPagination(data.page, data.pages, data.total);
    if(emptyState){
      if(!data.items.length){
        emptyState.classList.remove('hidden');
      } else {
        emptyState.classList.add('hidden');
      }
    }
    if(loading){
      loading.classList.add('hidden');
      loading.classList.remove('flex');
    }
  }

  function updateBulkUI(){
    const bulk = document.getElementById('bulkActions');
    const count = selected.size;
    if(!bulk) return;
    if(count){
      bulk.classList.remove('hidden');
      bulk.classList.add('flex');
    } else {
      bulk.classList.add('hidden');
      bulk.classList.remove('flex');
    }
    const sc = document.getElementById('selectedCount');
    if(sc) sc.textContent = `${count} selected`;
    const all = document.getElementById('selectAll');
    if(all){
      const totalRows = document.querySelectorAll('.row-select').length;
      all.checked = count && count === totalRows;
      all.indeterminate = count > 0 && count < totalRows;
    }
  }

  function renderUsers(items){
    tableBody.innerHTML = '';
    for(const u of items){
      const tr = document.createElement('tr');
      const locked = u.lock_until ? 'Yes' : 'No';
      const rolesArr = (u.roles||[]);
      const roles = rolesArr.map(r=>`<span class=\"inline-block px-2 py-0.5 text-[10px] font-medium rounded-full border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200\">${escapeHtml(r)}</span>`).join(' ');
      const isSelected = selected.has(u.id);
      const verifiedBadge = u.is_verified ? '<span class="inline-block px-2 py-0.5 text-[10px] rounded bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-100">Yes</span>' : '<span class="inline-block px-2 py-0.5 text-[10px] rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-100">No</span>';
      const docBadge = u.document_submitted ? '<span class="inline-block px-2 py-0.5 text-[10px] rounded bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-100">Yes</span>' : '<span class="inline-block px-2 py-0.5 text-[10px] rounded bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200">No</span>';
      tr.innerHTML = `
        <td><input type="checkbox" class="row-select" value="${u.id}" ${isSelected?'checked':''}></td>
  <td><a class="text-blue-600 hover:underline" href="${BASE}/admin/super/users/${u.id}/activity">${escapeHtml(u.username||'')}</a></td>
        <td class="truncate max-w-[220px]" title="${escapeHtml(u.email||'')}">${escapeHtml(u.email||'')}</td>
        <td class="space-x-1">${roles}</td>
        <td>${u.is_active ? 'Yes' : 'No'}</td>
        <td>${locked}</td>
        <td>${verifiedBadge}</td>
        <td>${docBadge}</td>
        <td>${u.failed_login_attempts}</td>
        <td>${u.last_login ? new Date(u.last_login).toLocaleString() : ''}</td>
        <td class="whitespace-nowrap px-2 py-1 space-x-1">
          <button class="px-2 py-1 text-xs border rounded border-blue-500 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900" data-action="roles" data-id="${u.id}">Roles</button>
          ${!u.is_verified ? `<button class=\"px-2 py-1 text-xs border rounded border-green-500 text-green-600 hover:bg-green-50 dark:hover:bg-green-900\" data-action=\"verify\" data-id=\"${u.id}\">Verify</button>` : ''}
          ${u.is_active ? `<button class=\"px-2 py-1 text-xs border rounded border-yellow-500 text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900\" data-action=\"deactivate\" data-id=\"${u.id}\">Deactivate</button>` : `<button class=\"px-2 py-1 text-xs border rounded border-green-500 text-green-600 hover:bg-green-50 dark:hover:bg-green-900\" data-action=\"activate\" data-id=\"${u.id}\">Activate</button>`}
          ${u.lock_until ? `<button class=\"px-2 py-1 text-xs border rounded border-red-500 text-red-600 hover:bg-red-50 dark:hover:bg-red-900\" data-action=\"unlock\" data-id=\"${u.id}\">Unlock</button>` : `<button class=\"px-2 py-1 text-xs border rounded border-red-500 text-red-600 hover:bg-red-50 dark:hover:bg-red-900\" data-action=\"lock\" data-id=\"${u.id}\">Lock</button>`}
        </td>`;
      tableBody.appendChild(tr);
    }
    updateBulkUI();
  }

  function renderPagination(page, pages, total){
    currentPage = page;
  if(paginationInfo) paginationInfo.textContent = `Page ${page} of ${pages} • ${total} user${total===1?'':'s'}`;
    paginationBtns.innerHTML = '';
    function btn(p, label){
      const b = document.createElement('button');
  b.className = 'px-2 py-1 text-xs rounded border ' + (p===page ? 'bg-blue-600 text-white border-blue-600' : 'border-blue-500 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900');
      b.textContent = label || p;
      b.disabled = p===page;
      b.addEventListener('click', ()=>fetchUsers(p));
      return b;
    }
    const start = Math.max(1, page-2);
    const end = Math.min(pages, start+4);
    if(page>1) paginationBtns.appendChild(btn(1,'«'));
    for(let p=start; p<=end; p++) paginationBtns.appendChild(btn(p));
    if(page<pages) paginationBtns.appendChild(btn(pages,'»'));
  }

  form.addEventListener('submit', e=>{e.preventDefault(); fetchUsers(1);});
  document.getElementById('resetFilters').addEventListener('click', ()=>{ form.reset(); fetchUsers(1); });

  tableBody.addEventListener('click', async e =>{
    const btn = e.target.closest('button[data-action]');
    if(!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    if(action==='roles') return openRolesModal(id);
    if(action==='verify'){
  openVerifyModal(id);
  return;
    }
    let endpoint;
    if(action==='activate') endpoint = `${BASE}/api/v1/super/users/${id}/activate`;
    else if(action==='deactivate') endpoint = `${BASE}/api/v1/super/users/${id}/deactivate`;
    else if(action==='lock') endpoint = `${BASE}/api/v1/super/users/${id}/lock`;
    else if(action==='unlock') endpoint = `${BASE}/api/v1/super/users/${id}/unlock`;
    if(!endpoint) return;
  await fetch(endpoint, {method:'POST', headers: jsonHeaders()});
    fetchUsers(currentPage);
  });

  tableBody.addEventListener('change', e =>{
    const cb = e.target.closest('.row-select');
    if(!cb) return;
    if(cb.checked) selected.add(cb.value); else selected.delete(cb.value);
    updateBulkUI();
  });

  const selectAll = document.getElementById('selectAll');
  if(selectAll){
    selectAll.addEventListener('change', e =>{
      const on = e.target.checked;
      selected.clear();
      document.querySelectorAll('.row-select').forEach(cb=>{ cb.checked = on; if(on) selected.add(cb.value); });
      updateBulkUI();
    });
  }

  const clearSelection = document.getElementById('clearSelection');
  if(clearSelection){
    clearSelection.addEventListener('click', ()=>{
      selected.clear();
      document.querySelectorAll('.row-select').forEach(cb=> cb.checked = false);
      updateBulkUI();
    });
  }

  const bulkActions = document.getElementById('bulkActions');
  if(bulkActions){
    bulkActions.addEventListener('click', async e =>{
      const btn = e.target.closest('button[data-bulk]');
      if(!btn) return;
      const action = btn.getAttribute('data-bulk');
      if(!selected.size) return;
      if(action==='roles') return openBulkRolesModal();
      if(action==='export') { exportSelectedToCSV(); return; }
      const confirmMap = {
        activate: 'Activate selected users?',
        deactivate: 'Deactivate selected users?',
        lock: 'Lock selected users (they will be unable to login)?',
        unlock: 'Unlock selected users?',
        verify: 'Verify selected users? (Users missing required documents will be skipped)',
        discard: 'Discard (delete) selected unverified users? This cannot be undone.'
      };
      if(confirmMap[action]){
        const ok = await openConfirm({title: 'Confirm Bulk Action', message: confirmMap[action], okText: action==='discard' ? 'Discard' : 'Confirm'});
        if(!ok) return;
      }
      let endpoint;
      if(action==='activate') endpoint = `${BASE}/api/v1/super/users/bulk/activate`;
      else if(action==='deactivate') endpoint = `${BASE}/api/v1/super/users/bulk/deactivate`;
      else if(action==='lock') endpoint = `${BASE}/api/v1/super/users/bulk/lock`;
      else if(action==='unlock') endpoint = `${BASE}/api/v1/super/users/bulk/unlock`;
      else if(action==='verify') endpoint = `${BASE}/api/v1/auth/bulk/verify-users`;
      else if(action==='discard') endpoint = `${BASE}/api/v1/auth/bulk/discard-users`;
      if(!endpoint) return;
  await fetch(endpoint,{method:'POST', headers: jsonHeaders(), body: JSON.stringify({user_ids:[...selected]})});
      fetchUsers(currentPage);
    });
  }

  function openRolesModal(id){
    editingUserId = id;
    const row = [...tableBody.querySelectorAll('tr')].find(r=> r.querySelector('button[data-id]')?.getAttribute('data-id')===id);
  const roleSpans = row ? Array.from(row.children[3].querySelectorAll('span')).map(s=>s.textContent.trim()) : [];
  document.querySelectorAll('#rolesForm input[type=checkbox]').forEach(cb=> cb.checked = roleSpans.includes(cb.value));
  openModal();
  }

  function openBulkRolesModal(){
    editingUserId = null;
    document.querySelectorAll('#rolesForm input[type=checkbox]').forEach(cb=> cb.checked=false);
  openModal();
  }

  document.getElementById('saveRolesBtn').addEventListener('click', async ()=>{
    const chosen = [...document.querySelectorAll('#rolesForm input[type=checkbox]:checked')].map(cb=>cb.value);
    if(editingUserId){
  await fetch(`${BASE}/api/v1/super/users/${editingUserId}/roles`, {method:'POST', headers: jsonHeaders(), body: JSON.stringify({roles: chosen})});
    } else if(selected.size){
  const ok = await openConfirm({title:'Apply Roles', message:'Apply selected roles to all chosen users?'});
  if(!ok) return;
  await fetch(`${BASE}/api/v1/super/users/bulk/roles`, {method:'POST', headers: jsonHeaders(), body: JSON.stringify({user_ids:[...selected], roles: chosen})});
    }
  closeModal();
    fetchUsers(currentPage);
  });

  function escapeHtml(str){
    return (str||'').replace(/[&<>\"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  }

  fetchUsers(1);

  // Advanced filters toggle
  const advToggle = document.getElementById('toggleAdvanced');
  const adv = document.getElementById('advancedFilters');
  if(advToggle && adv){
    advToggle.addEventListener('click', ()=>{
      const hidden = adv.classList.contains('hidden');
      if(hidden){
        adv.classList.remove('hidden');
        adv.classList.add('flex');
        advToggle.textContent = 'Hide Advanced';
      } else {
        adv.classList.add('hidden');
        adv.classList.remove('flex');
        advToggle.textContent = 'Advanced';
      }
    });
  }

  // Column sorting via headers
  const headers = document.querySelectorAll('#usersTable thead th.sortable');
  const sortState = { by: 'created_at', dir: 'desc' };
  function updateIndicators(){
    headers.forEach(h=>{
      const indicator = h.querySelector('.sort-indicator');
      if(!indicator) return;
      const col = h.getAttribute('data-sort');
      if(col === sortState.by){
        indicator.textContent = sortState.dir === 'asc' ? '▲' : '▼';
        indicator.classList.remove('opacity-0');
      } else {
        indicator.classList.add('opacity-0');
      }
    });
  }
  headers.forEach(h=>{
    h.addEventListener('click', ()=>{
      const col = h.getAttribute('data-sort');
      if(sortState.by === col){
        sortState.dir = (sortState.dir === 'asc') ? 'desc' : 'asc';
      } else {
        sortState.by = col;
        sortState.dir = 'asc';
      }
      form.querySelector('input[name="sort_by"]').value = sortState.by;
      form.querySelector('input[name="sort_dir"]').value = sortState.dir;
      updateIndicators();
      fetchUsers(1);
    });
  });
  updateIndicators();

  function exportSelectedToCSV(){
    if(!selected.size) return;
    const rows = [...tableBody.querySelectorAll('tr')].filter(r=> selected.has(r.querySelector('button[data-id]')?.getAttribute('data-id')));
    if(!rows.length) return;
    const header = ['id','username','email','roles','active','locked','failed_login_attempts','last_login'];
    const lines = [header.join(',')];
    rows.forEach(r=>{
      const id = r.querySelector('button[data-id]')?.getAttribute('data-id') || '';
      const cols = r.children;
      const username = cols[1]?.textContent.trim() || '';
      const email = cols[2]?.textContent.trim() || '';
      const roles = Array.from(cols[3].querySelectorAll('span')).map(s=>s.textContent.trim()).join('|');
      const active = cols[4]?.textContent.trim() || '';
      const locked = cols[5]?.textContent.trim() || '';
      const failed = cols[6]?.textContent.trim() || '';
      const lastLogin = cols[7]?.textContent.trim() || '';
      const esc = v=> '"'+ String(v).replace(/"/g,'""') + '"';
      lines.push([id,username,email,roles,active,locked,failed,lastLogin].map(esc).join(','));
    });
    const blob = new Blob([lines.join('\n')], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'users_export.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // Page jump
  const pageJumpInput = document.getElementById('pageJumpInput');
  const pageJumpGo = document.getElementById('pageJumpGo');
  if(pageJumpInput && pageJumpGo){
    pageJumpGo.addEventListener('click', ()=>{
      const target = parseInt(pageJumpInput.value,10);
      if(!isNaN(target) && target>0){
        fetchUsers(target);
      }
    });
    pageJumpInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); pageJumpGo.click(); }});
  }

  // Resizable columns
  const headerCells = document.querySelectorAll('#usersTable thead th[data-resizable="true"]');
  headerCells.forEach(th=>{
    const grip = document.createElement('div');
    grip.className = 'absolute top-0 right-0 h-full w-1 cursor-col-resize select-none opacity-0 hover:opacity-100 bg-blue-500/40';
    th.style.position = 'relative';
    th.appendChild(grip);
    let startX, startW;
    const minW = 60;
    function onMove(ev){
      const dx = ev.clientX - startX;
      let newW = startW + dx;
      if(newW < minW) newW = minW;
      th.style.width = newW + 'px';
    }
    function onUp(){
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    grip.addEventListener('mousedown', ev=>{
      startX = ev.clientX; startW = th.getBoundingClientRect().width;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      ev.preventDefault();
    });
  });

  // ----- Verification Modal Logic -----
  function openVerifyModal(id){
    verifyTargetId = id;
    if(!verifyModalEl) return;
    verifyModalEl.classList.remove('hidden');
    verifyModalOpen = true;
    loadVerifyDetails();
  }
  function closeVerifyModal(){
    if(!verifyModalEl) return;
    verifyModalEl.classList.add('hidden');
    verifyModalOpen = false;
    verifyTargetId = null;
  }
  if(verifyModalEl){
    verifyModalEl.addEventListener('click', e=>{
      if(e.target.matches('[data-vmodal-dismiss], [data-vmodal-dismiss] *') || e.target === verifyModalEl){
        closeVerifyModal();
      }
    });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape' && verifyModalOpen) closeVerifyModal(); });
  }

  async function loadVerifyDetails(){
    const body = document.getElementById('verifyModalBody');
    const docActions = document.getElementById('verifyDocActions');
    if(!verifyTargetId || !body) return;
    body.innerHTML = '<div class="text-xs text-gray-500">Loading...</div>';
    docActions.innerHTML = '';
    try {
      const r = await fetch(`${BASE}/api/v1/super/users/${verifyTargetId}`, {headers: authHeader()});
      if(!r.ok){ body.innerHTML = '<div class="text-xs text-red-600">Failed to load user.</div>'; return; }
      const data = await r.json();
      const u = data.user || {};
      body.innerHTML = `
        <div><span class="font-semibold">Username:</span> ${escapeHtml(u.username||'')}</div>
        <div><span class="font-semibold">Email:</span> ${escapeHtml(u.email||'')}</div>
        <div><span class="font-semibold">Employee ID:</span> ${escapeHtml(u.employee_id||'')}</div>
        <div><span class="font-semibold">Mobile:</span> ${escapeHtml(u.mobile||'')}</div>
        <div><span class="font-semibold">User Type:</span> ${escapeHtml(u.user_type||'')}</div>
        <div><span class="font-semibold">Created:</span> ${u.created_at ? new Date(u.created_at).toLocaleString() : ''}</div>
        <div><span class="font-semibold">Verified:</span> ${u.is_verified ? 'Yes' : 'No'}</div>
        <div><span class="font-semibold">Document Submitted:</span> ${u.document_submitted ? 'Yes' : 'No'}</div>
      `;
      if(u.document_submitted){
        const viewBtn = document.createElement('button');
        viewBtn.className = 'px-3 py-2 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-xs';
        viewBtn.textContent = 'View Document';
        viewBtn.addEventListener('click', ()=> window.open(`/api/v1/auth/user-document/${verifyTargetId}`, '_blank'));
        docActions.appendChild(viewBtn);
      }
    } catch(e){ body.innerHTML = '<div class="text-xs text-red-600">Error.</div>'; }
  }

  const confirmVerifyBtn = document.getElementById('confirmVerifyBtn');
  const discardUserBtn = document.getElementById('discardUserBtn');
  if(confirmVerifyBtn){
    confirmVerifyBtn.addEventListener('click', async ()=>{
      if(!verifyTargetId) return;
      const ok = await openConfirm({title:'Confirm Verification', message:'Verify this user?'});
      if(!ok) return;
      await fetch(`${BASE}/api/v1/auth/verify-user`, {method:'POST', headers: jsonHeaders(), body: JSON.stringify({user_id: verifyTargetId})});
      closeVerifyModal();
      fetchUsers(currentPage);
    });
  }
  if(discardUserBtn){
    discardUserBtn.addEventListener('click', async ()=>{
      if(!verifyTargetId) return;
      const ok = await openConfirm({title:'Discard User', message:'This will permanently delete the unverified user. Continue?', okText:'Discard'});
      if(!ok) return;
      await fetch(`${BASE}/api/v1/auth/discard-user`, {method:'POST', headers: jsonHeaders(), body: JSON.stringify({user_id: verifyTargetId})});
      closeVerifyModal();
      fetchUsers(1);
    });
  }
})();
