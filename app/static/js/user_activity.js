// User Activity Page Logic
(function(){
  const BASE = '/video';
  const root = document.getElementById('user-activity-root');
  if(!root) return;
  const userId = root.getAttribute('data-user-id');
  const loginEl = document.getElementById('loginHistory');
  const uploadEl = document.getElementById('uploadHistory');
  const viewEl = document.getElementById('viewHistory');
  const secEl = document.getElementById('securityEvents');
  const metaEl = document.getElementById('uaMeta');

  function fmt(ts){ if(!ts) return ''; try { return new Date(ts).toLocaleString(); } catch { return ts; } }

  async function load(){
    try {
      const r = await fetch(`${BASE}/api/v1/super/users/${userId}/activity`, {headers:{'Accept':'application/json'}});
      if(!r.ok){ metaEl.textContent = 'Failed to load activity'; return; }
      const data = await r.json();
      const u = data.user || {};      
      metaEl.innerHTML = `<div class="text-xs">Username: <strong>${escapeHtml(u.username||'')}</strong> • Email: ${escapeHtml(u.email||'')} • Created: ${fmt(u.created_at)} • Last Login: ${fmt(u.last_login)} • Last Password Change: ${fmt(u.last_password_change)} • Roles: ${(u.roles||[]).map(escapeHtml).join(', ')}</div>`;

      renderList(loginEl, data.logins, l=> `${fmt(l.created_at)} — ${escapeHtml(l.event||'login')}`);
      renderList(uploadEl, data.uploads, v=> `${fmt(v.created_at)} — ${escapeHtml(v.title)} (${v.uuid})`);
      renderList(viewEl, data.views, v=> `${fmt(v.created_at)} — ${escapeHtml(v.title||v.video_id)} (${v.video_id})`);
      renderList(secEl, data.security_events, e=> `${fmt(e.created_at)} — ${escapeHtml(e.event)} ${e.detail? '— '+escapeHtml(e.detail):''}`);
    } catch(e){ metaEl.textContent = 'Error loading activity'; }
  }

  function renderList(container, items, mapFn){
    if(!container) return;
    container.innerHTML='';
    if(!items || !items.length){ container.innerHTML = '<div class="text-gray-400">No data</div>'; return; }
    const frag = document.createDocumentFragment();
    items.forEach(i=>{ const div = document.createElement('div'); div.className='px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700'; div.textContent = mapFn(i); frag.appendChild(div); });
    container.appendChild(frag);
  }

  function escapeHtml(str){ return (str||'').replace(/[&<>"']/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

  load();
})();
