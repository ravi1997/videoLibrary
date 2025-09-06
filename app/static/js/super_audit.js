(function(){
  const exportBtn = document.getElementById('exportAudit');
  const auditForm = document.getElementById('auditFilter');
  const resetBtn = document.getElementById('resetAudit');
  const auditTable = document.getElementById('auditTable');
  const loadMoreBtn = document.getElementById('loadMoreAudit');

  let nextCursor = null;
  let activeParams = {};

  function renderRows(items, append=false){
    if(!auditTable) return;
    const tbody = auditTable.querySelector('tbody');
    if(!append) tbody.innerHTML='';
    items.forEach(it=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${it.id}</td><td>${it.event}</td><td>${it.user_id||''}</td><td>${it.target_user_id||''}</td><td>${(it.detail||'').substring(0,120)}</td><td>${it.created_at}</td>`;
      tbody.appendChild(tr);
    });
  }

  async function fetchAudit(params, append=false){
    const p = {...params};
    if(append && nextCursor) p.last_id = nextCursor;
    const qs = new URLSearchParams(p).toString();
    const r = await fetch(`/api/v1/super/audit/list?${qs}`);
    if(!r.ok) return;
    const data = await r.json();
    renderRows(data.items || [], append);
    nextCursor = data.next_cursor || null;
    if(loadMoreBtn){
      loadMoreBtn.disabled = !data.has_more;
      loadMoreBtn.style.display = data.has_more ? 'inline-block':'none';
    }
  }

  if(auditForm){
    auditForm.addEventListener('submit', e=>{
      e.preventDefault();
      const fd = new FormData(auditForm);
      activeParams = {limit: fd.get('limit') || 50};
      for(const [k,v] of fd.entries()) if(v && k!=='limit') activeParams[k]=v;
      nextCursor = null;
      fetchAudit(activeParams, false);
    });
  }
  if(resetBtn){
    resetBtn.addEventListener('click', ()=>{
      auditForm.reset();
      activeParams = {limit:50};
      nextCursor = null;
      fetchAudit(activeParams, false);
    });
  }
  if(loadMoreBtn){
    loadMoreBtn.addEventListener('click', ()=>{
      if(!nextCursor) return; fetchAudit(activeParams, true);
    });
  }
  if(exportBtn){
    exportBtn.addEventListener('click', async ()=>{
      exportBtn.disabled=true; exportBtn.textContent='Exporting...';
      try {
        const p = {...activeParams};
        // Remove pagination specific params
        delete p.last_id; delete p.limit; // server will use its own export limit
        const qs = new URLSearchParams(p).toString();
        const r = await fetch(`/api/v1/super/audit/export${qs?('?' + qs):''}`);
        if(r.ok){
          const data = await r.json();
          const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href=url; a.download='audit_logs.json'; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(()=> URL.revokeObjectURL(url), 5000);
        }
      } finally { exportBtn.disabled=false; exportBtn.textContent='Export (JSON)'; }
    });
  }

  // initial load
  if(auditTable){
    activeParams = {limit:50};
    fetchAudit(activeParams);
  }
})();
