(function(){
  const BASE = '/video';
  const maintBtn = document.getElementById('toggleMaint');
  const maintState = document.getElementById('maintState');
  if(maintBtn){
    maintBtn.addEventListener('click', async ()=>{
      const next = maintState.textContent.trim()==='on' ? 'off':'on';
      const reasonInput = document.getElementById('maintReason');
      const payload = { mode: next };
      if(reasonInput && next==='on') payload.reason = reasonInput.value.trim();
      maintBtn.disabled = true; maintBtn.textContent = '...';
      try {
        const r = await fetch(BASE + '/api/v1/super/maintenance', {method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify(payload)});
        if(r.ok){
          const data = await r.json();
          maintState.textContent = data.mode;
            maintState.classList.toggle('danger', data.mode==='on');
            if(reasonInput) reasonInput.value = data.reason || '';
        }
      } catch(e){ console.error(e); }
      finally { maintBtn.disabled = false; maintBtn.textContent = 'Toggle'; }
    });
  }
  const exportBtn = document.getElementById('exportAudit');
  if(exportBtn){
    exportBtn.addEventListener('click', async ()=>{
      exportBtn.disabled = true; exportBtn.textContent='Exporting...';
      try {
        const p = {...overviewParams};
        delete p.last_id; delete p.limit;
        const qs = new URLSearchParams(p).toString();
        const r = await fetch(`${BASE}/api/v1/super/audit/export${qs?('?' + qs):''}`);
        if(r.ok){
          const data = await r.json();
          const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
          const url = URL.createObjectURL(blob);
          const a = document.getElementById('downloadLink');
          a.href = url; a.download = 'audit_logs.json'; a.click();
          setTimeout(()=> URL.revokeObjectURL(url), 5000);
        }
      } finally { exportBtn.disabled=false; exportBtn.textContent='Export (JSON)'; }
    });
  }

  // --- Sparkline Rendering (simple) ---
  function drawSpark(canvas){
    if(!canvas) return;
    let data;
    try{ data = JSON.parse(canvas.getAttribute('data-series')||'[]'); }catch(e){ return; }
    if(!data.length) return;
    const counts = data.map(d=>d.count||0);
    const days = data.map(d=>d.day);
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.clientWidth;
    const h = canvas.height = canvas.getAttribute('height') || 40;
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const span = Math.max(1, max - min);
    ctx.clearRect(0,0,w,h);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#2563eb';
    ctx.beginPath();
    counts.forEach((v,i)=>{
      const x = (i/(counts.length-1))* (w-2) + 1;
      const y = h - ((v - min)/span)* (h-4) - 2;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    // Fill gradient
    const g = ctx.createLinearGradient(0,0,0,h);
    g.addColorStop(0,'rgba(37,99,235,0.25)');
    g.addColorStop(1,'rgba(37,99,235,0)');
    ctx.lineTo(w-1,h-1); ctx.lineTo(1,h-1); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
  }
  drawSpark(document.getElementById('signupSpark'));
  drawSpark(document.getElementById('uploadSpark'));

  // --- Relative password expiry ---
  function renderPwdExp(){
    const nodes = document.querySelectorAll('.pwd-exp');
    const now = Date.now()/1000;
    nodes.forEach(n=>{
      const secs = parseInt(n.getAttribute('data-exp-seconds'),10); if(!secs) return;
      const future = now + secs;
      const delta = future - now;
      if(delta <= 0){ n.textContent = 'expired'; n.classList.add('danger'); return; }
      const d = Math.floor(delta/86400);
      const h = Math.floor((delta%86400)/3600);
      const m = Math.floor((delta%3600)/60);
      if(d>0) n.textContent = `in ${d}d ${h}h`;
      else if(h>0) n.textContent = `in ${h}h ${m}m`;
      else n.textContent = `in ${m}m`;
    });
  }
  renderPwdExp();
  setInterval(renderPwdExp, 60_000);

  // --- Audit Filters ---
  const auditForm = document.getElementById('auditFilter');
  const auditTable = document.getElementById('auditTable');
  const resetBtn = document.getElementById('resetAudit');
  const summaryNode = document.getElementById('overviewAuditSummary');
  const endNode = document.getElementById('overviewAuditEnd');
  let overviewCursor = null;
  let overviewParams = {limit:25};
  let loadingAudit = false;
  async function fetchAudit(params, append=false){
    if(loadingAudit) return; loadingAudit = true;
    const p = {...params};
    if(append && overviewCursor) p.last_id = overviewCursor;
    const qs = new URLSearchParams(p).toString();
    const r = await fetch(`${BASE}/api/v1/super/audit/list?${qs}`);
    if(!r.ok) return;
    const data = await r.json();
    if(!auditTable) return;
    const tbody = auditTable.querySelector('tbody');
    if(!append) tbody.innerHTML='';
    (data.items||[]).forEach(it=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${it.id}</td><td>${it.event}</td><td>${it.user_id||''}</td><td>${it.target_user_id||''}</td><td>${it.created_at}</td>`;
      tbody.appendChild(tr);
    });
    overviewCursor = data.next_cursor || null;
    const moreBtn = document.getElementById('overviewAuditMore');
    if(moreBtn){
      moreBtn.disabled = !data.has_more;
      moreBtn.style.display = data.has_more ? 'inline-block':'none';
    }
    if(endNode){ endNode.style.display = data.has_more ? 'none':'inline'; }
    if(summaryNode){
      const totalShown = (auditTable.querySelectorAll('tbody tr')||[]).length;
      summaryNode.textContent = `${totalShown} row(s) shown${data.order?` | order=${data.order}`:''}`;
    }
    loadingAudit = false;
  }
  if(auditForm){
    auditForm.addEventListener('submit', e=>{
      e.preventDefault();
      const fd = new FormData(auditForm);
  const params = {};
  for(const [k,v] of fd.entries()) if(v) params[k]=v;
      overviewParams = params; overviewCursor = null; fetchAudit(overviewParams, false);
    });
  }
  if(resetBtn){
    resetBtn.addEventListener('click', ()=>{
      auditForm.reset();
      overviewParams = {limit:25}; overviewCursor = null; fetchAudit(overviewParams,false);
    });
  }
  const moreBtn = document.getElementById('overviewAuditMore');
  if(moreBtn){
    moreBtn.addEventListener('click', ()=>{ if(overviewCursor) fetchAudit(overviewParams,true); });
  }

})();
