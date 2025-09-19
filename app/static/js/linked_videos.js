(() => {
  const sQ = id => document.getElementById(id);
  const token = () => localStorage.getItem('token') || '';
  const headers = () => ({ 'Accept':'application/json','Authorization':`Bearer ${token()}` });
  const state = { page:1, pages:1, pageSize:20, q:'', sort_dir:'desc', subject:null, loading:false };

  function escapeHtml(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

  async function fetchJSON(url){
    const r = await fetch(url,{headers:headers()});
    if(!r.ok) throw new Error(await r.text()||r.status);
    return r.json();
  }

  function applyContextMeta(sub){
    const meta = sQ('contextMeta'); if(!meta) return;
    const pill = (icon,label,extra='') => `<span class=\"px-3 py-1 rounded-full text-[11px] bg-[color:var(--surface-alt)] border border-[color:var(--border)] flex items-center gap-2\">${icon} <strong class=\"font-semibold\">${label}</strong>${extra?`<span class=\"opacity-70\">${extra}</span>`:''}</span>`;
    if(sub.type==='surgeon') {
      let html = pill('🩺','Surgeon',`ID ${escapeHtml(sub.id)}`);
      if(sub.aggregated && Array.isArray(sub.surgeon_group)) {
        const chips = sub.surgeon_group.map(g=>`<a href=\"/linked-video/${encodeURIComponent(g.id)}\" class=\"chip no-underline hover:shadow-sm\" title=\"View only this surgeon\">${escapeHtml(g.name)}${g.type?` <span class='opacity-60'>${escapeHtml(g.type)}</span>`:''}</a>`).join(' ');
        html += `<div class=\"w-full flex flex-wrap gap-2 mt-2 items-center\"><span class=\"text-[10px] uppercase tracking-wide font-semibold opacity-60\">Group</span>${chips}</div>`;
      }
      meta.innerHTML = html;
    } else {
      meta.innerHTML = pill('👤','User',`ID ${escapeHtml(sub.id)}`);
    }
  }

  function formatCompact(n){ const x=Number(n)||0; if(x>=1_000_000) return (x/1_000_000).toFixed(1).replace(/\.0$/,'')+'M'; if(x>=1_000) return (x/1_000).toFixed(1).replace(/\.0$/,'')+'K'; return String(x); }
  function formatAge(iso){ if(!iso) return ''; try{ const d=new Date(iso); const diff=(Date.now()-d.getTime())/1000; const day=86400, week=day*7, month=day*30, year=day*365; if(diff<day) return 'today'; if(diff<week) return Math.floor(diff/day)+'d ago'; if(diff<month) return Math.floor(diff/week)+'w ago'; if(diff<year) return Math.floor(diff/month)+'mo ago'; return Math.floor(diff/year)+'y ago'; }catch{return'';} }
  function showLoading(){ const grid=sQ('videoResults'); if(!grid) return; grid.innerHTML=''; for(let i=0;i<8;i++){ const sk=document.createElement('article'); sk.className='card p-3 animate-pulse'; sk.innerHTML=`<div class="rounded-lg h-40 bg-[color:var(--border)] mb-3"></div><div class="h-4 bg-[color:var(--border)] rounded w-4/5 mb-2"></div><div class="h-3 bg-[color:var(--border)] rounded w-3/5"></div>`; grid.appendChild(sk);} }
  function renderList(items){
    const grid = sQ('videoResults');
    const empty = sQ('videoEmpty');
    if(!grid) return;
    grid.replaceChildren();
    if(!items.length){
      grid.classList.add('hidden');
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    grid.classList.remove('hidden');
    const frag=document.createDocumentFragment();
    items.forEach(v=> frag.appendChild(videoCard(v)) );
    grid.appendChild(frag);
  }
  function videoCard(v){
    const BASE = '/video';
    const art=document.createElement('article');
    art.className='card p-0 overflow-hidden group hover:shadow-xl transition-shadow flex flex-col';
    const href= BASE + '/' + encodeURIComponent(v.uuid||'');
    const viewTxt = formatCompact(v.views||0) + ' views';
    art.innerHTML=`<a class="block relative" href="${href}">
      <div class="w-full aspect-video relative overflow-hidden rounded-b-none">
        <img class="w-full h-full object-cover block transition-transform duration-300 group-hover:scale-[1.03]" src="${BASE}/api/v1/video/thumbnails/${encodeURIComponent(v.uuid||'')}.jpg" alt="${escapeHtml(v.title||'Video')}">
        <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent opacity-60 group-hover:opacity-70 transition-opacity"></div>
        <div class="absolute bottom-2 left-2 right-2 flex items-center justify-between text-[10px] text-white font-medium">
          <span class="px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm">${viewTxt}</span>
          ${(v.surgeons!=null)?`<span class='px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm'>${v.surgeons} surgeons</span>`:''}
        </div>
      </div>
      <div class="p-3">
        <h3 class="font-semibold line-clamp-2 text-[color:var(--text)] tracking-tight">${escapeHtml(v.title||'Untitled')}</h3>
        <p class="text-[11px] muted mt-2 flex items-center gap-2 flex-wrap">
          <span>${formatAge(v.created_at)}</span>
          <span class="w-1 h-1 rounded-full bg-[color:var(--border)]"></span>
          <span class="font-mono opacity-50">${(v.uuid||'').slice(0,8)}</span>
        </p>
      </div>
    </a>`;
    return art;
  }

  function updateMeta(data){
    state.pages = data.pages;
    const stats = sQ('videoStats');
    stats && (stats.textContent = `${data.total} total videos`);
    const info = sQ('videoPageInfo');
  if(info) { info.textContent = `Page ${data.page} of ${data.pages}`; }
  // disable/enable buttons
  const prev = sQ('videoPrev'); const next = sQ('videoNext');
  if(prev) prev.disabled = data.page <= 1;
  if(next) next.disabled = data.page >= data.pages;
    if(data.subject){ state.subject = data.subject; applyContextMeta(data.subject); }
  }

  async function load(){
    const BASEP = '/video';
    const base = state.subject?.type==='surgeon' ? `${BASEP}/api/v1/admin/surgeons/${state.subject.id}/videos` : `${BASEP}/api/v1/admin/users/${state.subject.id}/videos`;
    const url = `${base}?q=${encodeURIComponent(state.q)}&page=${state.page}&page_size=${state.pageSize}&sort_dir=${state.sort_dir}`;
    state.loading = true; showLoading();
    try{ const data = await fetchJSON(url); renderList(data.items||[]); updateMeta(data); }catch(e){ console.error(e); } finally { state.loading=false; }
  }

  function changePage(delta){ state.page = Math.min(Math.max(1,state.page+delta), state.pages); load(); }

  function init(){
  const ctxEl = document.getElementById('linkedCtx');
  const surgeon_id = ctxEl?.getAttribute('data-surgeon-id') || null;
  const user_id = ctxEl?.getAttribute('data-user-id') || null;
  if(surgeon_id){ state.subject = { type:'surgeon', id: surgeon_id }; }
  else if(user_id){ state.subject = { type:'user', id: user_id }; }
    else { sQ('contextMeta').textContent='No context supplied'; return; }
    applyContextMeta(state.subject);
  function doSearch(){ state.q = (sQ('videoSearch').value||'').trim(); state.page=1; sQ('activeQuery').textContent = state.q?`Query: "${state.q}"`:''; const clr=sQ('clearSearch'); if(clr) clr.classList.toggle('hidden', !state.q); load(); }
  sQ('videoSearchBtn')?.addEventListener('click', doSearch);
  // keyboard pagination
  document.addEventListener('keydown', e => { if(e.key==='ArrowRight') { if(state.page < state.pages) changePage(1); } else if(e.key==='ArrowLeft'){ if(state.page>1) changePage(-1); } });
  sQ('videoSearch')?.addEventListener('keydown', e => { if(e.key==='Enter') { e.preventDefault(); doSearch(); }});
  sQ('clearSearch')?.addEventListener('click', () => { const inp=sQ('videoSearch'); if(!inp) return; inp.value=''; doSearch(); });
    sQ('videoPrev')?.addEventListener('click', () => changePage(-1));
    sQ('videoNext')?.addEventListener('click', () => changePage(1));
    document.getElementById('pageSizeGroup')?.addEventListener('click', e => {
      const btn = e.target.closest('.seg'); if(!btn) return;
      document.querySelectorAll('#pageSizeGroup .seg').forEach(b=>b.classList.remove('active','bg-[color:var(--brand-600)]','text-white'));
      btn.classList.add('active','bg-[color:var(--brand-600)]','text-white');
      state.pageSize = +btn.dataset.size; state.page = 1; load();
    });

    load();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
