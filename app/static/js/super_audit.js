(function(){
  const exportBtn = document.getElementById('exportAudit');
  const auditForm = document.getElementById('auditFilter');
  const resetBtn = document.getElementById('resetAudit');
  const auditTable = document.getElementById('auditTable');

  async function fetchAudit(params){
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`/api/v1/super/audit/list?${qs}`);
    if(!r.ok) return;
    const data = await r.json();
    if(!auditTable) return;
    const tbody = auditTable.querySelector('tbody');
    tbody.innerHTML='';
    data.items.forEach(it=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${it.id}</td><td>${it.event}</td><td>${it.user_id||''}</td><td>${it.target_user_id||''}</td><td>${(it.detail||'').substring(0,80)}</td><td>${it.created_at}</td>`;
      tbody.appendChild(tr);
    });
  }

  if(auditForm){
    auditForm.addEventListener('submit', e=>{
      e.preventDefault();
      const fd = new FormData(auditForm);
      const params = {};
      for(const [k,v] of fd.entries()) if(v) params[k]=v;
      fetchAudit(params);
    });
  }
  if(resetBtn){
    resetBtn.addEventListener('click', ()=>{
      auditForm.reset();
      fetchAudit({limit:50});
    });
  }
  if(exportBtn){
    exportBtn.addEventListener('click', async ()=>{
      exportBtn.disabled=true; exportBtn.textContent='Exporting...';
      try {
        const r = await fetch('/api/v1/super/audit/export');
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
})();
