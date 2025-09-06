// favourites.js – extracted from inline script for CSP compliance
(function(){
  const API = {
    list: "/api/v1/video/favorite?page={page}&per_page={size}&sort={sort}",
    remove: (id) => `/api/v1/video/${encodeURIComponent(id)}/favorite`,
  };
  const PAGE_SIZE = 12;
  const state = {
    view: localStorage.getItem("fav.view") || "grid",
    sort: localStorage.getItem("fav.sort") || "recent",
    page: +(localStorage.getItem("fav.page") || 1),
    pages: 1,
    total: 0,
    items: [],
  };
  const $ = (s,r=document)=>r.querySelector(s);
  const favGrid = $("#favGrid"), emptyState=$("#emptyState"), totalCount=$("#totalCount"), pageNumber=$("#pageNumber");
  const prevBtn=$("#prevBtn"), nextBtn=$("#nextBtn"), sortRecent=$("#sortRecent"), sortAlpha=$("#sortAlpha"), viewToggle=$("#viewToggle");

  function init(){
    sortRecent?.addEventListener('click',()=>{state.sort='recent';persist();refresh();});
    sortAlpha?.addEventListener('click',()=>{state.sort='alpha';persist();refresh();});
    viewToggle?.addEventListener('click',()=>{state.view= state.view==='grid'?'list':'grid';persist();render(state.items);});
    prevBtn?.addEventListener('click',()=>changePage(-1));
    nextBtn?.addEventListener('click',()=>changePage(1));
    refresh();
  }
  function persist(){
    localStorage.setItem('fav.view',state.view);
    localStorage.setItem('fav.sort',state.sort);
    localStorage.setItem('fav.page',String(state.page));
  }
  function changePage(d){
    const next=Math.min(Math.max(1,state.page+d),state.pages||1); if(next===state.page)return; state.page=next;persist();refresh();
  }
  async function refresh(){
    const url=API.list.replace('{page}',encodeURIComponent(state.page)).replace('{size}',encodeURIComponent(PAGE_SIZE)).replace('{sort}',encodeURIComponent(state.sort));
    try{
      const res=await fetch(url,{headers:{'Accept':'application/json','Authorization':`Bearer ${localStorage.getItem('token')||''}`}});
      if(res.status===401){location.href='/login';return;}
      const data=await res.json();
      state.items=data.items||[]; state.total=(data.count??data.total??state.items.length)||0; state.page=data.page||state.page; state.pages=data.pages||Math.max(1,Math.ceil(state.total/PAGE_SIZE));
      if(state.sort==='alpha') state.items.sort((a,b)=>(a.title||'').localeCompare(b.title||''));
      else state.items.sort((a,b)=>new Date(b.published_at||0)-new Date(a.published_at||0));
      render(state.items);
    }catch(e){console.error('Failed favourites',e); state.items=[]; state.total=0; state.pages=1; render(state.items);} }
  function render(items){
    if(!favGrid)return; if(totalCount) totalCount.textContent=String(state.total); if(pageNumber) pageNumber.textContent=`Page ${state.page} of ${state.pages||1}`; disable(prevBtn,state.page<=1); disable(nextBtn,state.page>=(state.pages||1));
    if(!items.length){ emptyState?.classList.remove('hidden'); favGrid.replaceChildren(); return;} else emptyState?.classList.add('hidden');
    if(state.view==='list'){favGrid.classList.remove('grid'); favGrid.classList.add('list-view');} else {favGrid.classList.remove('list-view'); favGrid.classList.add('grid');}
    const frag=document.createDocumentFragment(); items.forEach(v=>frag.appendChild(state.view==='list'?row(v):card(v))); favGrid.replaceChildren(frag);
  }
  function card(v){
    const a=document.createElement('article'); a.className='card p-0 overflow-hidden hover:shadow-xl transition-shadow';
    a.innerHTML=`<a class="block relative group" href="${escapeAttr(v.url||`/${encodeURIComponent(v.uuid||'')}`)}" aria-label="${escapeAttr(v.title||'Video')}">
      <div class="w-full aspect-video bg-[color:var(--border)] relative overflow-hidden">
        <img class="w-full h-full object-cover block" src="${escapeAttr(thumb(v))}" alt="${escapeAttr(v.title||'Video')}" loading="lazy" decoding="async">
        <span class="absolute bottom-2 right-2 text-xs px-2 py-1 rounded bg-black/70 text-white">${fmtDuration(v.duration)}</span>
      </div>
      <div class="p-3">
        <h3 class="font-semibold line-clamp-2 text-[color:var(--text)]">${escapeHtml(v.title||'Untitled')}</h3>
        <p class="text-sm mt-1 muted line-clamp-2">${escapeHtml(v.description||v.category_name||'')}</p>
        <div class="flex items-center justify-between mt-3">
          <span class="text-xs muted">${escapeHtml(meta(v))}</span>
          <button data-unf="${escapeAttr(v.uuid||'')}" class="text-xs px-2 py-1 rounded border border-[color:var(--border)] hover:bg-[color:var(--brand-50)]">Remove</button>
        </div>
      </div></a>`;
    a.querySelector('button[data-unf]')?.addEventListener('click',onUnfavouriteClick); return a; }
  function row(v){
    const a=document.createElement('a'); a.className='card p-3 flex gap-3 items-center hover:shadow-xl transition-shadow'; a.href=v.url||`/${encodeURIComponent(v.uuid||'')}`;
    a.innerHTML=`<div class="w-48 shrink-0 aspect-video rounded-lg overflow-hidden bg-[color:var(--border)]"><img class="w-full h-full object-cover block" src="${escapeAttr(thumb(v))}" alt="${escapeAttr(v.title||'Video')}" loading="lazy" decoding="async"></div>
      <div class="min-w-0 flex-1"><h3 class="font-semibold text-[color:var(--text)] line-clamp-1">${escapeHtml(v.title||'Untitled')}</h3><p class="text-sm muted mt-1 line-clamp-2">${escapeHtml(v.description||v.category_name||'')}</p><div class="text-xs muted mt-2">${escapeHtml(meta(v))}</div></div>
      <div class="shrink-0"><button data-unf="${escapeAttr(v.uuid||'')}" class="text-xs px-2 py-1 rounded border border-[color:var(--border)] hover:bg-[color:var(--brand-50)]">Remove</button></div>`;
    a.querySelector('button[data-unf]')?.addEventListener('click',onUnfavouriteClick); return a; }
  async function onUnfavouriteClick(e){ e.preventDefault(); e.stopPropagation(); const id=e.currentTarget?.getAttribute('data-unf'); if(!id)return; const prev=state.items.slice(); state.items=state.items.filter(v=>String(v.id)!==String(id)); state.total=Math.max(0,state.total-1); render(state.items); try{ const res=await fetch(API.remove(id),{method:'DELETE',headers:{'Accept':'application/json','Authorization':`Bearer ${localStorage.getItem('token')||''}`}}); if(!res.ok) throw new Error(res.status); refresh(); }catch(err){ console.error('Failed unfavourite',err); state.items=prev; state.total=prev.length; render(state.items); alert('Could not remove from favourites. Please try again.'); } }
  function disable(el,on){ if(!el)return; el.disabled=!!on; el.style.opacity=on?0.6:1; el.style.pointerEvents=on?'none':'auto'; }
  function thumb(v){
    if (v.uuid) return `/api/v1/video/thumbnails/${encodeURIComponent(v.uuid)}.jpg`;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'><rect width='16' height='9' fill='%23ddd'/><path d='M0 9 L5.5 4.5 L9 7 L12 5 L16 9 Z' fill='%23bbb'/></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }
  function fmtDuration(sec){ const s=Number.isFinite(+sec)?Math.max(0,Math.round(+sec)):0; const m=Math.floor(s/60),r=s%60; return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`; }
  function meta(v){ const parts=[]; if(v.views!=null) parts.push(`${formatCompact(v.views)} views`); if(v.published_at) parts.push(new Date(v.published_at).toLocaleDateString()); return parts.join(' • ');} 
  function formatCompact(n){ const x=Number(n)||0; if(x>=1_000_000) return (x/1_000_000).toFixed(1).replace(/\.0$/,'')+'M'; if(x>=1_000) return (x/1_000).toFixed(1).replace(/\.0$/,'')+'K'; return String(x);} 
  function escapeHtml(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
  function escapeAttr(s){return String(s).replaceAll('"','&quot;');}
  init();
})();
