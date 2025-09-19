// Video metadata edit page logic
(function(){
  const BASE = '/video';
  const vid = (document.getElementById('video-id')?.textContent || '').trim();
  if(!vid) return;

  const titleEl = document.getElementById('title');
  const descEl = document.getElementById('description');
  const catEl = document.getElementById('category');
  const catList = document.getElementById('categoryList');
  const tagsEl = document.getElementById('tags');
  const tagList = document.getElementById('tagList');
  const form = document.getElementById('editForm');
  const saveBtn = document.getElementById('saveBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const statusMsg = document.getElementById('statusMsg');

  function authHeaders(){
    const t = localStorage.getItem('token');
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  }

  function setStatus(msg, type){
    statusMsg.textContent = msg || '';
    statusMsg.classList.remove('text-red-600','text-green-600');
    if(type==='error') statusMsg.classList.add('text-red-600');
    if(type==='ok') statusMsg.classList.add('text-green-600');
  }

  async function load(){
    try{
      const [res, catsRes, tagsRes] = await Promise.all([
        fetch(`${BASE}/api/v1/video/${encodeURIComponent(vid)}`, { headers: { 'Accept': 'application/json', ...authHeaders() } }),
        fetch(BASE + '/api/v1/video/categories', { headers: { 'Accept':'application/json', ...authHeaders() } }),
        fetch(BASE + '/api/v1/video/tags', { headers: { 'Accept':'application/json', ...authHeaders() } }),
      ]);
      if(!res.ok){ setStatus('Failed to load video', 'error'); return; }
      const data = await res.json();
      if(titleEl) titleEl.value = data.title || '';
      if(descEl) descEl.value = data.description || '';
      if(catEl) catEl.value = (data.category && (data.category.name || data.category)) || '';
      if(tagsEl) tagsEl.value = Array.isArray(data.tags) ? data.tags.map(t => (t.name || t).toString()).join(', ') : '';
      const surg = Array.isArray(data.surgeons) ? data.surgeons : [];
      const surgeonsText = surg.map(s => `${(s.name||'').trim()}:${(s.type||'').trim()}`).filter(Boolean).join('\n');
      const surgEl = document.getElementById('surgeons');
      if(surgEl) surgEl.value = surgeonsText;

      // Populate category/tag suggestions
      try{
        const cats = catsRes.ok ? await catsRes.json() : [];
        if(Array.isArray(cats) && catList){
          catList.replaceChildren(...cats.map(c => { const o=document.createElement('option'); o.value = c.name || ''; return o; }));
        }
      }catch{}
      try{
        const tarr = tagsRes.ok ? await tagsRes.json() : [];
        if(Array.isArray(tarr) && tagList){
          tagList.replaceChildren(...tarr.map(t => { const o=document.createElement('option'); o.value = (typeof t==='string'?t:(t.name||'')); return o; }));
        }
      }catch{}
    } catch(e){ setStatus('Network error', 'error'); }
  }

  form?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    saveBtn.disabled = true; setStatus('Saving…');
    try{
      // Build payload for metadata update by names (creates if missing)
      const tags = (tagsEl.value||'').split(',').map(s=>s.trim()).filter(Boolean).map(n=>({name:n}));
      const surgeons = (document.getElementById('surgeons').value||'').split(/\n+/).map(l=>{
        const [name, type=''] = l.split(':').map(s=> (s||'').trim());
        return name ? {name, type} : null;
      }).filter(Boolean);
      const body = {
        uuid: vid,
        title: titleEl.value || '',
        description: descEl.value || '',
        category: { name: (catEl.value||'').trim() },
        tags,
        surgeons,
      };
      const res = await fetch(`${BASE}/api/v1/video/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok){
        setStatus(data.message || data.error || 'Save failed', 'error');
        saveBtn.disabled = false; return;
      }
      setStatus('Saved', 'ok');
      setTimeout(()=>{ window.location.href = `${BASE}/${encodeURIComponent(vid)}`; }, 500);
    } catch(e){ setStatus('Network error', 'error'); saveBtn.disabled = false; }
  });

  cancelBtn?.addEventListener('click', (e)=>{
    e.preventDefault();
    window.location.href = `${BASE}/${encodeURIComponent(vid)}`;
  });

  load();
})();
