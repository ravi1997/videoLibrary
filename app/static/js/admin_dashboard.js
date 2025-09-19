// Admin Dashboard client logic (enhanced UI)
(function(){
  const root = document.getElementById('dashboardRoot');
  if(!root) return;
  const kpiBar = document.getElementById('kpiBar');
  const refreshBtn = document.getElementById('refreshNow');
  const toggleAutoBtn = document.getElementById('toggleAuto');
  const refreshStatus = document.getElementById('refreshStatus');
  const lastUpdatedEl = document.getElementById('lastUpdated');
  const timeframeControls = document.getElementById('timeframeControls');
  const sparkTooltip = document.getElementById('sparkTooltip');
  const tsCanvas = document.getElementById('tsChart');
  const tsTooltip = document.getElementById('tsTooltip');
  const tsAxisLabels = document.getElementById('tsAxisLabels');
  const tsToggles = document.getElementById('tsToggles');
  const REFRESH_MS = 60000;
  let timer; let auto = true; let lastData = null; let lastUpdatedAt = null; let timeframeDays = 14; let rangeDays = 14;

  function fmt(n){ return typeof n==='number'? n.toLocaleString(): n; }
  function rel(dateStr){ if(!dateStr) return '-'; try { const d=new Date(dateStr); const diff=Date.now()-d.getTime(); const mins=Math.floor(diff/60000); if(mins<60) return mins+"m ago"; const hrs=Math.floor(mins/60); if(hrs<24) return hrs+"h ago"; const days=Math.floor(hrs/24); return days+"d ago";} catch{return dateStr;} }

  function section(title, body, opts={}){
    const accent = opts.accent || '';
    const id = `sec_${title.toLowerCase().replace(/[^a-z0-9]+/g,'_')}`;
    return `<div class="dash-card card condensed" data-collapsible="true" id="${id}">
      <div class="card-head" role="button" tabindex="0" aria-expanded="true">
        <button class="icon-btn collapse-btn" aria-label="Collapse">−</button>
        <h2 class="card-title">${accent}${title}</h2>
        <button class="icon-btn refresh-btn" title="Refresh section" data-section="${title}">↻</button>
      </div>
      <div class="card-body">${body}</div>
    </div>`;
  }

  function list(items, map){ if(!items.length) return '<div class="text-xs muted">None</div>'; return `<ul class="m-0 p-0 list-none space-y-1">${items.map(map).join('')}</ul>`; }

  function render(m){
    lastData = m;
    lastUpdatedAt = new Date();
    tickUpdated();
    if(kpiBar){
      kpiBar.innerHTML = kpis(m).map(k=>`<div class="kpi">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-sub">${k.sub||''}</div>
      </div>`).join('');
    }
    root.innerHTML = `
        <div class="dashboard-panels${localStorage.getItem('dash_masonry')==='1'?' masonry':''}">
        ${section('Users', usersSection(m.users), {accent:'👥 '})}
        ${section('Videos', videosSection(m.videos), {accent:'🎬 '})}
        ${section('Surgeons', surgeonsSection(m.surgeons), {accent:'🩺 '})}
        ${section('Engagement', engagementSection(m), {accent:'💬 '})}
        ${section('Security', securitySection(m.security), {accent:'🔐 '})}
        ${section('Recent Activity', recentSection(m), {accent:'⏱ '})}
      </div>
      <div class="tiny mt-4 muted">Generated at: ${new Date(m.generated_at).toLocaleString()}</div>
    `;
  bindSectionRefresh();
  bindCollapsibles();
  buildTimeSeries(m);
      ensureMasonryToggle();
  const rootDash = document.querySelector('.admin-dashboard');
  if(rootDash) rootDash.classList.add('loaded');
  }

  /* Masonry toggle (persists in localStorage). Add a control button next to refresh if container #masonryToggle exists or create ephemeral. */
  function ensureMasonryToggle(){
    let bar = document.getElementById('dashboardControls');
    if(!bar){
      // attempt to locate a place near timeframe controls if exists
      bar = timeframeControls?.parentElement;
    }
    if(!bar) return; // silent
    if(bar.querySelector('.masonry-toggle-btn')) return; // already added
    const btn = document.createElement('button');
    btn.type='button';
    btn.className='icon-btn masonry-toggle-btn';
    btn.style.width='32px';
    btn.style.height='32px';
    btn.style.lineHeight='0';
    btn.style.display='inline-flex';
    btn.style.alignItems='center';
    btn.style.justifyContent='center';
    const makeSVG = (isMasonry)=>{
      if(isMasonry){
        // Currently masonry active -> show standard uniform grid icon to indicate switch target
        return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
      }
      // Currently grid -> show staggered masonry icon (irregular blocks)
      return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><rect x="3" y="3" width="7" height="10" rx="1"/><rect x="12" y="3" width="9" height="5" rx="1"/><rect x="12" y="10" width="4" height="11" rx="1"/><rect x="17" y="10" width="4" height="11" rx="1"/></svg>`;
    };
    const setLabel = ()=>{
      const active = localStorage.getItem('dash_masonry')==='1';
      btn.innerHTML = makeSVG(active) + `<span class="sr-only">Toggle ${active?'Grid':'Masonry'} Layout</span>`;
      btn.title = active ? 'Switch to Equal Grid Layout' : 'Switch to Masonry Layout';
      btn.setAttribute('aria-pressed', active ? 'true':'false');
      btn.setAttribute('aria-label', active ? 'Masonry active, switch to grid' : 'Grid active, switch to masonry');
    };
    setLabel();
    btn.addEventListener('click', ()=>{
      const cur = localStorage.getItem('dash_masonry')==='1';
      if(cur) localStorage.removeItem('dash_masonry'); else localStorage.setItem('dash_masonry','1');
      setLabel();
      // re-render panels only
      if(lastData){
        const panelsHTML = `<div class="dashboard-panels${localStorage.getItem('dash_masonry')==='1'?' masonry':''}">`+
          root.querySelector('.dashboard-panels').innerHTML + '</div>';
        root.querySelector('.dashboard-panels').outerHTML = panelsHTML;
        bindSectionRefresh();
        bindCollapsibles();
      }
    });
    bar.appendChild(btn);
  }

  function kpis(m){
    return [
      { label:'Users', value:fmt(m.users.total), sub:`+7d ${fmt(m.users.last_7_days)}` },
      { label:'Videos', value:fmt(m.videos.total), sub:`+30d ${fmt(m.videos.last_30_days)}` },
      { label:'Views', value:fmt(m.videos.total_views), sub:`Avg ${fmt(m.videos.avg_views)}` },
      { label:'Surgeons', value:fmt(m.surgeons.total), sub:`Linked ${fmt(m.surgeons.linked)}` },
      { label:'Active Tokens', value:fmt(m.security.active_refresh_tokens), sub:'Security' }
    ];
  }

  function usersSection(u){
    const roles = Object.entries(u.roles||{}).map(([r,c])=>`<div class="flex justify-between text-xs"><span class="uppercase tracking-wide">${r}</span><span>${fmt(c)}</span></div>`).join('');
    return `<div class="grid grid-cols-2 gap-3 text-sm">
      <div><div class="font-semibold">Total</div><div>${fmt(u.total)}</div></div>
      <div><div class="font-semibold">Active</div><div>${fmt(u.active)}</div></div>
      <div><div class="font-semibold">Verified</div><div>${fmt(u.verified)}</div></div>
      <div><div class="font-semibold">Email Verified</div><div>${fmt(u.email_verified)}</div></div>
      <div><div class="font-semibold">Locked</div><div>${fmt(u.locked)}</div></div>
      <div><div class="font-semibold">+7d</div><div>${fmt(u.last_7_days)}</div></div>
      <div><div class="font-semibold">+30d</div><div>${fmt(u.last_30_days)}</div></div>
    </div>
    <details class="mt-3"><summary class="text-xs cursor-pointer select-none">Role Distribution</summary><div class="mt-2 space-y-1">${roles||'<div class=text-xs>No roles</div>'}</div></details>`;
  }
  function videosSection(v){
    const statuses = Object.entries(v.status_counts||{}).map(([s,c])=>`<div class="flex justify-between text-xs"><span>${s}</span><span>${fmt(c)}</span></div>`).join('');
    const topViewed = list(v.top_viewed||[], x=>`<li class="text-xs flex justify-between"><span class="truncate max-w-[70%]" title="${x.title}">${x.title}</span><span>${fmt(x.views)}</span></li>`);
    const fav = list(v.top_favourited||[], x=>`<li class="text-xs flex justify-between"><span class="truncate max-w-[70%]" title="${x.title}">${x.title}</span><span>${fmt(x.favourites)} ❤</span></li>`);
    const series = (timeframeDays === 14 ? v.series_14d : v.series_14d) || [];// placeholder for future 30d
    const sparkId = `spark_${Math.random().toString(36).slice(2)}`;
    const sparkCanvas = `<canvas id="${sparkId}" height="40" class="w-full block mt-2" data-series-len="${series.length}"></canvas>`;
    queueMicrotask(()=> drawSparkline(series, sparkId));
    return `<div class="grid grid-cols-2 gap-3 text-sm">
      <div><div class="font-semibold">Total</div><div>${fmt(v.total)}</div></div>
      <div><div class="font-semibold">+7d</div><div>${fmt(v.last_7_days)}</div></div>
      <div><div class="font-semibold">+30d</div><div>${fmt(v.last_30_days)}</div></div>
      <div><div class="font-semibold">Views</div><div>${fmt(v.total_views)}</div></div>
      <div><div class="font-semibold">Avg Views</div><div>${fmt(v.avg_views)}</div></div>
      <div><div class="font-semibold">Avg Duration</div><div>${fmt(v.avg_duration)}s</div></div>
    </div>
    <div class="mt-2">
      <div class="flex items-center justify-between text-[10px] uppercase tracking-wide font-semibold mb-1"><span>Views 14d</span><span>${series.length? fmt(series[series.length-1].total_views):'-'}</span></div>
      ${sparkCanvas}
    </div>
    <details class="mt-3"><summary class="text-xs cursor-pointer select-none">Status Breakdown</summary><div class="mt-2 space-y-1">${statuses||'<div class=text-xs>None</div>'}</div></details>
    <details class="mt-3"><summary class="text-xs cursor-pointer select-none">Top Viewed</summary><div class="mt-2">${topViewed}</div></details>
    <details class="mt-3"><summary class="text-xs cursor-pointer select-none">Top Favourited</summary><div class="mt-2">${fav}</div></details>`;
  }
  function surgeonsSection(s){
    const top = list(s.top_by_videos||[], x=>`<li class="text-xs flex justify-between"><span class="truncate max-w-[70%]" title="${x.name}">${x.name}</span><span>${fmt(x.videos)}</span></li>`);
    return `<div class="grid grid-cols-2 gap-3 text-sm">
      <div><div class="font-semibold">Total</div><div>${fmt(s.total)}</div></div>
      <div><div class="font-semibold">Linked</div><div>${fmt(s.linked)}</div></div>
      <div><div class="font-semibold">Unlinked</div><div>${fmt(s.unlinked)}</div></div>
    </div>
    <details class="mt-3"><summary class="text-xs cursor-pointer select-none">Top by Videos</summary><div class="mt-2">${top}</div></details>`;
  }
  function engagementSection(m){
    const favs = m.favourites || { total: 0 };
    return `<div class="grid grid-cols-2 gap-3 text-sm">
      <div><div class="font-semibold">Total Favourites</div><div>${fmt(favs.total)}</div></div>
      <div><div class="font-semibold">Avg Views/Video</div><div>${fmt(m.videos.avg_views)}</div></div>
      <div><div class="font-semibold">Avg Duration</div><div>${fmt(m.videos.avg_duration)}s</div></div>
      <div><div class="font-semibold">Top Viewed First</div><div>${m.videos.top_viewed?.[0]? fmt(m.videos.top_viewed[0].views):'-'}</div></div>
    </div>`;
  }
  function securitySection(sec){
    return `<div class="grid grid-cols-2 gap-3 text-sm">
      <div><div class="font-semibold">Active Tokens</div><div>${fmt(sec.active_refresh_tokens)}</div></div>
      <div><div class="font-semibold">Locked Users</div><div>${fmt(sec.locked_users)}</div></div>
    </div>`;
  }
  function recentSection(m){
    const rv = list(m.videos.recent||[], x=>`<li class="text-xs flex justify-between"><span class="truncate max-w-[70%]" title="${x.title}">${x.title}</span><span>${rel(x.created_at)}</span></li>`);
    const ru = list(m.users.recent||[], x=>`<li class="text-xs flex justify-between"><span class="truncate max-w-[60%]" title="${x.username}">${x.username}</span><span>${rel(x.created_at)}</span></li>`);
    return `<details open><summary class="text-xs cursor-pointer select-none">Recent Videos</summary><div class="mt-2">${rv}</div></details>
    <details class="mt-3" open><summary class="text-xs cursor-pointer select-none">Recent Users</summary><div class="mt-2">${ru}</div></details>`;
  }

  async function load(){
    try {
      const r = await fetch('/video/api/v1/admin/dashboard/metrics', { headers: { 'Accept':'application/json' } });
      if(!r.ok){ root.innerHTML = `<div class='text-red-600 text-sm'>Failed to load metrics (${r.status})</div>`; return; }
      const data = await r.json();
      render(data);
    } catch(e){
      root.innerHTML = `<div class='text-red-600 text-sm'>Error: ${e}</div>`;
    }
  }

  function schedule(){ if(!auto) return; if(timer) clearTimeout(timer); timer = setTimeout(()=>{ load().then(schedule); }, REFRESH_MS); }

  function bindSectionRefresh(){
    root.querySelectorAll('.refresh-btn').forEach(btn=>{
      btn.addEventListener('click', (e)=>{ e.preventDefault(); load(); });
    });
  }
  function bindCollapsibles(){
    root.querySelectorAll('.dash-card .card-head').forEach(head=>{
      const card = head.parentElement;
      const collapseBtn = head.querySelector('.collapse-btn');
      const body = card.querySelector('.card-body');
      function toggle(){
        const expanded = head.getAttribute('aria-expanded') === 'true';
        if(expanded){ body.style.display='none'; head.setAttribute('aria-expanded','false'); collapseBtn.textContent='+'; collapseBtn.setAttribute('aria-label','Expand'); }
        else { body.style.display=''; head.setAttribute('aria-expanded','true'); collapseBtn.textContent='−'; collapseBtn.setAttribute('aria-label','Collapse'); }
      }
      collapseBtn.addEventListener('click', (e)=>{ e.stopPropagation(); toggle(); });
      head.addEventListener('dblclick', toggle);
      head.addEventListener('keydown', (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); toggle(); }});
    });
  }

  function tickUpdated(){
    if(!lastUpdatedEl || !lastUpdatedAt) return;
    const diff = Date.now() - lastUpdatedAt.getTime();
    const secs = Math.floor(diff/1000);
    let label;
    if(secs < 60) label = `${secs}s ago`;
    else if(secs < 3600) label = `${Math.floor(secs/60)}m ago`;
    else label = `${Math.floor(secs/3600)}h ago`;
    lastUpdatedEl.textContent = `Last updated ${label}`;
  }
  setInterval(tickUpdated, 1000);

  if(timeframeControls){
    timeframeControls.querySelectorAll('.tf-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        if(btn.disabled) return;
        timeframeControls.querySelectorAll('.tf-btn').forEach(b=> b.classList.remove('active'));
        btn.classList.add('active');
        timeframeDays = parseInt(btn.dataset.range,10);
        if(lastData) render(lastData); // re-render with timeframe
      });
    });
  }

  function buildTimeSeries(m){
    if(!tsCanvas || !m) return;
    const full = (m.videos.series_90d||[]);
    const baseAll = full.slice(-rangeDays);
    // Adaptive sampling (avoid overcrowding > 60 points)
    let base = baseAll;
    const maxPoints = 60;
    if(base.length > maxPoints){
      const step = Math.ceil(base.length / maxPoints);
      base = base.filter((_,i)=> i%step===0);
      if(base[base.length-1] !== baseAll[baseAll.length-1]) base.push(baseAll[baseAll.length-1]);
    }
    if(!base.length){ tsCanvas.getContext('2d').clearRect(0,0,tsCanvas.width,tsCanvas.height); return; }
    // Build derived series
    // New users per day estimation: diff cumulative users
    const usersDaily = [];
    for(let i=1;i<base.length;i++){
      const prev = base[i-1]; const cur = base[i];
      const uDelta = (cur.total_users ?? 0) - (prev.total_users ?? 0);
      usersDaily.push(uDelta < 0 ? 0 : uDelta);
    }
    // Align length (pad first day)
    usersDaily.unshift(usersDaily[0]||0);
    const favPerVideo = (m.favourites.total && m.videos.total) ? (m.favourites.total / m.videos.total) : 0;
    const avgViews = m.videos.avg_views || 0;
  const seriesDefs = [
      { key:'views', label:'Views', color:'#2563eb', values: base.map(p=>p.total_views) },
      { key:'users_new', label:'Users New', color:'#059669', values: usersDaily },
      { key:'avg_views', label:'Avg Views', color:'#6366f1', values: base.map(()=> avgViews) },
      { key:'fav_per_video', label:'Fav/Video', color:'#f59e0b', values: base.map(()=> favPerVideo) }
    ];
    // Initialize toggles once
    if(tsToggles && !tsToggles.dataset.bound){
      const rangeBtns = `<div class='range-switch'><button data-range='14' class='rs-btn active'>14d</button><button data-range='30' class='rs-btn'>30d</button><button data-range='90' class='rs-btn'>90d</button></div>`;
    tsToggles.innerHTML = rangeBtns + seriesDefs.map(s=>`<button class="ts-series-badge active" data-series="${s.key}"><span class="dot" style="background:${s.color}"></span>${s.label}</button>`).join('');
      tsToggles.addEventListener('click', e=>{
        const rBtn = e.target.closest('.rs-btn');
        if(rBtn){
          rangeDays = parseInt(rBtn.dataset.range,10);
          tsToggles.querySelectorAll('.rs-btn').forEach(b=> b.classList.toggle('active', b===rBtn));
      const trl = document.getElementById('trendRangeLabel'); if(trl) trl.textContent = rBtn.dataset.range + 'd';
          buildTimeSeries(lastData); return;
        }
        const btn = e.target.closest('button[data-series]'); if(!btn) return; btn.classList.toggle('active'); drawMultiSeries(base, seriesDefs);
      });
      tsToggles.dataset.bound = '1';
    }
    drawMultiSeries(base, seriesDefs);
  }

  function drawMultiSeries(base, seriesDefs){
    const active = Array.from(tsToggles.querySelectorAll('.ts-series-badge.active')).map(b=> b.dataset.series);
    const ctx = tsCanvas.getContext('2d');
    const w = tsCanvas.width = tsCanvas.clientWidth || 800; const h = tsCanvas.height = 240;
    ctx.clearRect(0,0,w,h);
    if(!active.length) return;
    const actSeries = seriesDefs.filter(s=> active.includes(s.key));
    // Y scale
    let allVals = actSeries.flatMap(s=> s.values);
    const min = Math.min(...allVals);
    const max = Math.max(...allVals);
    const span = (max - min) || 1;
    const pad = 8;
    const left = 4; const bottom = 18; const top = 6; const right = 4;
    const chartW = w - left - right; const chartH = h - top - bottom;
    // grid lines / background gradient depending on theme
    const dark = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
    const bgGrad = ctx.createLinearGradient(0,0,0,h);
    bgGrad.addColorStop(0, dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)');
    bgGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = bgGrad; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'; ctx.lineWidth = 1; ctx.beginPath();
    for(let g=0; g<=4; g++){ const gy = top + (g/4)*chartH; ctx.moveTo(left,gy); ctx.lineTo(left+chartW,gy);} ctx.stroke();
    // min/max annotation
    ctx.font='10px system-ui'; ctx.fillStyle = dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)'; ctx.textAlign='left';
    ctx.fillText(max.toString(), left+2, top+10); ctx.fillText(min.toString(), left+2, top+chartH-2);
    actSeries.forEach(s=>{
      ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = s.color; s.values.forEach((v,i)=>{
        const x = left + (i/(s.values.length-1))*chartW; const y = top + chartH - ((v - min)/span)*chartH; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }); ctx.stroke();
      // Points
      ctx.fillStyle = s.color; s.values.forEach((v,i)=>{ const x = left + (i/(s.values.length-1))*chartW; const y = top + chartH - ((v - min)/span)*chartH; ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill(); });
    });
    // Axis labels
    if(tsAxisLabels){ tsAxisLabels.innerHTML = `<span>${base[0].day}</span><span>${base[base.length-1].day}</span>`; }
    // Tooltip
    tsCanvas.onmousemove = (e)=>{
      const rect = tsCanvas.getBoundingClientRect(); const xPos = e.clientX - rect.left; const idx = Math.round((xPos - left)/chartW * (base.length-1));
      if(idx < 0 || idx >= base.length){ tsTooltip.classList.add('hidden'); return; }
      const day = base[idx].day;
      let html = `<div class='tt-date'>${day}</div>`;
  actSeries.forEach(s=>{ const val = s.values[idx]; html += `<div class='tt-row'><span style='display:inline-block;width:8px;height:8px;background:${s.color};border-radius:2px;margin-right:4px'></span>${s.label}: <strong>${fmt(typeof val==='number'? val:0)}</strong></div>`; });
      tsTooltip.innerHTML = html; tsTooltip.style.left = (rect.left + window.scrollX + xPos + 14)+ 'px'; tsTooltip.style.top = (rect.top + window.scrollY + 10)+ 'px'; tsTooltip.classList.remove('hidden');
    };
    tsCanvas.onmouseleave = ()=> tsTooltip.classList.add('hidden');
  }

  function buildUserSeries(m){
    const base = (m.videos.series_14d||[]).map(x=>x.day);
    // Fallback: distribute last_7_days across 7 days linearly
    let values = [];
    if(base.length){
      const avg = m.users.last_7_days ? Math.max(1, Math.round(m.users.last_7_days/7)) : 0;
      values = base.map(()=> avg);
    }
    return { labels: base, values };
  }

  function buildMiniChart(title, values, labels, opts){
    const wrap = document.createElement('div');
    wrap.className = 'card mini-chart';
    wrap.innerHTML = `<h3>${title}</h3><canvas></canvas><div class="meta"><span>${labels[0]||''}</span><span>${labels[labels.length-1]||''}</span></div>`;
    const canvas = wrap.querySelector('canvas');
    drawMiniLine(canvas, values, labels, opts||{});
    return wrap;
  }

  function drawMiniLine(canvas, values, labels, opts){
    if(!canvas || !values.length) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.clientWidth || 300;
    const h = canvas.height = 140;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    ctx.clearRect(0,0,w,h);
    const grad = ctx.createLinearGradient(0,0,w,0);
    const gcols = opts.gradient || ['#60a5fa','#2563eb'];
    grad.addColorStop(0,gcols[0]); grad.addColorStop(1,gcols[1]);
    ctx.lineWidth = 2; ctx.strokeStyle = grad; ctx.beginPath();
    if(values.length === 1){
      const y = h/2;
      ctx.moveTo(2,y); ctx.lineTo(w-2,y);
      ctx.stroke();
      // draw point
      ctx.beginPath(); ctx.fillStyle=gcols[1]; ctx.arc(w/2,y,4,0,Math.PI*2); ctx.fill();
    } else {
      values.forEach((v,i)=>{
        const x = (i/(values.length-1))*(w-2)+1;
        const y = h - ((v-min)/span)*(h-6) - 3;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      });
      ctx.stroke();
    }
    // subtle fill
    if(values.length > 1){
      ctx.lineTo(w,h); ctx.lineTo(0,h); ctx.closePath();
      const fill = ctx.createLinearGradient(0,0,0,h);
      fill.addColorStop(0,'rgba(96,165,250,0.28)');
      fill.addColorStop(1,'rgba(96,165,250,0)');
      ctx.fillStyle = fill; ctx.fill();
    }
  }

  function buildDonutChart(title, segments){
    const wrap = document.createElement('div');
    wrap.className = 'card mini-chart';
    wrap.innerHTML = `<h3>${title}</h3><canvas class="donut"></canvas><div class="meta"></div>`;
    const canvas = wrap.querySelector('canvas');
    drawDonut(canvas, segments);
    return wrap;
  }
  function drawDonut(canvas, segments){
    if(!canvas) return; const total = segments.reduce((a,s)=>a+s.value,0) || 1;
    const ctx = canvas.getContext('2d');
    const size = 180; canvas.width = size; canvas.height = size; const r = size/2 - 8; const cx = size/2; const cy = size/2;
    ctx.clearRect(0,0,size,size);
    let start = -Math.PI/2; const palette = ['#60a5fa','#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#14b8a6'];
    segments.sort((a,b)=>b.value-a.value);
    segments.forEach((seg,i)=>{
      const angle = (seg.value/total)*Math.PI*2;
      ctx.beginPath(); ctx.strokeStyle = palette[i % palette.length]; ctx.lineWidth = 24; ctx.arc(cx,cy,r,start,start+angle,false); ctx.stroke();
      seg._mid = start + angle/2; seg._color = ctx.strokeStyle; start += angle;});
    // center text
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text') || '#111';
    ctx.font = '600 14px system-ui, sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(total===1 && segments.length===0 ? '—' : total.toString(), cx, cy);
    // legend (inline around donut)
    const legend = document.createElement('div'); legend.className='donut-legend';
    legend.style.display='flex'; legend.style.flexWrap='wrap'; legend.style.gap='4px'; legend.style.marginTop='4px'; legend.style.fontSize='.55rem';
    segments.slice(0,5).forEach(seg=>{ const item=document.createElement('span'); item.style.display='inline-flex'; item.style.alignItems='center'; item.style.gap='4px'; item.innerHTML=`<span style="width:10px;height:10px;background:${seg._color};display:inline-block;border-radius:2px"></span>${seg.label} ${seg.value}`; legend.appendChild(item); });
    canvas.parentElement.appendChild(legend);
  }

  function buildGaugeChart(title, value, maxValue, opts){
    maxValue = maxValue || 1; if(value > maxValue) maxValue = value;
    const wrap = document.createElement('div');
    wrap.className = 'card mini-chart';
    wrap.innerHTML = `<h3>${title}</h3><canvas class="gauge" height="140"></canvas><div class="meta"></div>`;
    const canvas = wrap.querySelector('canvas');
    drawGauge(canvas, value, maxValue, opts||{});
    return wrap;
  }
  function drawGauge(canvas, value, maxValue, opts){
    if(!canvas) return; const ctx = canvas.getContext('2d'); const w = canvas.width = canvas.clientWidth || 260; const h = canvas.height = 140; const cx = w/2; const cy = h*0.8; const r = Math.min(w/2 - 10, h - 20);
    ctx.clearRect(0,0,w,h);
    const start = Math.PI; const end = 2*Math.PI; ctx.lineCap='round';
    ctx.lineWidth = 14; ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.beginPath(); ctx.arc(cx,cy,r,start,end,false); ctx.stroke();
    const pct = maxValue ? (value / maxValue) : 0; const sweep = pct * Math.PI;
    const color = opts.color || '#2563eb';
    const grad = ctx.createLinearGradient(0,0,w,0); grad.addColorStop(0,color); grad.addColorStop(1,color);
    ctx.strokeStyle = grad; ctx.beginPath(); ctx.arc(cx,cy,r,start,start+sweep,false); ctx.stroke();
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text') || '#111'; ctx.font='600 16px system-ui'; ctx.textAlign='center';
    const formatter = opts.format || ((v)=>Math.round(v));
    ctx.fillText(formatter(value), cx, cy - 6);
    ctx.font='500 10px system-ui'; ctx.fillStyle = 'var(--text-muted)'; ctx.fillText(`max ${formatter(maxValue)}`, cx, cy + 14);
  }

  if(refreshBtn){ refreshBtn.addEventListener('click', ()=> load()); }
  if(toggleAutoBtn){ toggleAutoBtn.addEventListener('click', ()=> {
    auto = !auto;
    toggleAutoBtn.textContent = auto ? '⏸ Pause Auto' : '▶ Resume Auto';
    toggleAutoBtn.dataset.auto = auto ? 'on':'off';
    if(refreshStatus) refreshStatus.textContent = auto ? 'Auto-refresh ON':'Auto-refresh OFF';
    if(auto){ schedule(); } else if(timer) { clearTimeout(timer); }
  }); }

  load().then(()=> schedule());

  // -------- Sparkline Drawer --------
  function drawSparkline(series, id){
    if(!series || !series.length) return;
    const el = document.getElementById(id);
    if(!el) return;
    const ctx = el.getContext('2d');
    const w = el.width = el.clientWidth || 300;
    const h = el.height = el.height; // keep set height
    const vals = series.map(s=> s.total_views);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    ctx.clearRect(0,0,w,h);
    // gradient
    const grad = ctx.createLinearGradient(0,0,w,0);
    grad.addColorStop(0,'#60a5fa');
    grad.addColorStop(1,'#2563eb');
    ctx.lineWidth = 2;
    ctx.strokeStyle = grad;
    ctx.beginPath();
    series.forEach((pt,i)=>{
      const x = (i/(series.length-1)) * (w-2) + 1;
      const norm = (pt.total_views - min)/span;
      const y = h - (norm * (h-4)) - 2;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    // fill area
    const lastY = h - ((vals[vals.length-1]-min)/span * (h-4)) - 2;
    ctx.lineTo(w,lastY);
    ctx.lineTo(w,h);
    ctx.lineTo(0,h);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0,0,0,h);
    fill.addColorStop(0,'rgba(96,165,250,0.35)');
    fill.addColorStop(1,'rgba(96,165,250,0)');
    ctx.fillStyle = fill;
    ctx.fill();

  // interactive tooltip removed (superseded by unified chart)
  }
})();
