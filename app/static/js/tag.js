/* ==========================================================================
   RPC Surgical Video Library — Tag page logic (no dependencies)
   Similar to category.js but filters by a single tag.
   ========================================================================== */

(() => {
  const CFG = {
    API_TAGS: "/api/v1/video/tags",
    API_VIDEOS: "/api/v1/video/", // supports ?tags=&page=&page_size=&sort=
    PAGE_SIZE: 12,
    TIMEOUT_MS: 8000,
  };

  const url = new URL(location.href);
  let currentTag = extractTagFromPath(location.pathname) || url.searchParams.get("tag") || localStorage.getItem("tag.current") || "";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const dom = {
    tagName: $("#tagName"),
    tagList: $("#tagList"),

    sortBtns: $$("button.sort-btn"),
    viewToggle: $("#viewToggle"),

    grid: $("#tagGrid"),
    pageNumber: $("#pageNumber"),
    prevBtn: $("#prevBtn"),
    nextBtn: $("#nextBtn"),

    tplCard: $("#tagCardTpl"),
    tplRow: $("#tagRowTpl"),
  };

  const state = loadStateFor(currentTag);
  let lastData = { items: [], total: 0, page: 1, pages: 1 };

  function init(){
    if(dom.tagName) dom.tagName.textContent = prettify(currentTag) || "All";
    dom.sortBtns.forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const v = btn.getAttribute('data-sort');
        if(!v) return;
        state.sort = v; persist(); updateActiveSort(); state.page = 1; refreshVideos();
      });
    });
    updateActiveSort();
    if(dom.viewToggle){
      dom.viewToggle.addEventListener('click', ()=>{ state.view = state.view==='grid'?'list':'grid'; persist(); applyViewMode(); render(lastData); });
      applyViewMode();
    }
    dom.prevBtn?.addEventListener('click', ()=> changePage(-1));
    dom.nextBtn?.addEventListener('click', ()=> changePage(1));

    refreshTags();
    refreshVideos();
  }

  function extractTagFromPath(pathname){
    const parts = pathname.split('/').filter(Boolean);
    const i = parts.findIndex(p=> p==='tag' || p==='tags');
    if(i>=0 && parts[i+1]) return decodeURIComponent(parts[i+1]);
    return null;
  }

  function prettify(slug){ return (slug||'').replace(/[-_]+/g,' ').replace(/\b\w/g, m=> m.toUpperCase()); }

  function key(k){ return `tag.${currentTag || 'all'}.${k}`; }
  function loadStateFor(tag){
    return {
      tag: tag || '',
      sort: localStorage.getItem(`tag.${tag || 'all'}.sort`) || 'recent',
      view: localStorage.getItem(`tag.${tag || 'all'}.view`) || 'grid',
      page: +(localStorage.getItem(`tag.${tag || 'all'}.page`) || 1),
      pageSize: +(localStorage.getItem(`tag.${tag || 'all'}.pageSize`) || CFG.PAGE_SIZE),
      totalPages: 1,
      totalCount: 0,
    };
  }
  function persist(){
    localStorage.setItem('tag.current', currentTag);
    localStorage.setItem(key('sort'), state.sort);
    localStorage.setItem(key('view'), state.view);
    localStorage.setItem(key('page'), String(state.page));
    localStorage.setItem(key('pageSize'), String(state.pageSize));
  }

  function updateActiveSort(){
    dom.sortBtns.forEach(b=>{
      const active = b.getAttribute('data-sort') === state.sort;
      b.classList.toggle('ring-1', active);
      b.classList.toggle('ring-[color:var(--brand-600)]', active);
      b.classList.toggle('font-semibold', active);
    });
  }
  function applyViewMode(){ if(dom.viewToggle) dom.viewToggle.textContent = 'Toggle Grid/List'; }
  function changePage(delta){
    const next = Math.min(Math.max(1, state.page + delta), state.totalPages || 1);
    if(next === state.page) return; state.page = next; persist(); refreshVideos();
  }

  async function refreshTags(){
    try{
      const res = await fetch(CFG.API_TAGS, { headers: { 'Accept':'application/json' } });
      if(!res.ok) return;
      const tags = await res.json();
      if(!Array.isArray(tags)) return;
      dom.tagList.innerHTML = '';
      tags.forEach(t=>{
        const name = (t.name || t).toString();
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'btn-ghost w-full justify-start rounded-lg flex items-center gap-2 no-underline';
        a.href = `/tag/${encodeURIComponent(name)}`;
        a.textContent = name;
        if(name.toLowerCase() === (currentTag||'').toLowerCase()) a.classList.add('ring-1','ring-[color:var(--brand-600)]');
        li.appendChild(a); dom.tagList.appendChild(li);
      });
    } catch {}
  }

  async function refreshVideos(){
    const params = new URLSearchParams();
    if(currentTag) params.append('tags', currentTag);
    params.set('page', String(state.page));
    params.set('per_page', String(state.pageSize));
    params.set('sort', state.sort);
    const url = `${CFG.API_VIDEOS}?${params.toString()}`;
    try{
      const res = await fetch(url, { headers: { 'Accept':'application/json' } });
      const data = res.ok ? await res.json() : { items: [], page:1, pages:1, total:0 };
      lastData = data;
      render(data);
    } catch {
      render({ items: [], page:1, pages:1, total:0 });
    }
  }

  function render(result){
    state.totalPages = result.pages || 1;
    state.totalCount = result.total || 0;
    dom.pageNumber.textContent = `Page ${result.page || 1}`;
    if(state.view === 'grid'){
      dom.grid.classList.add('grid'); dom.grid.classList.remove('list-view');
      renderCardsInto(result.items, dom.grid);
    } else {
      dom.grid.classList.remove('grid'); dom.grid.classList.add('list-view');
      renderRowsInto(result.items, dom.grid);
    }
  }

  async function renderCardsInto(items, mount){
    if(!mount) return; const frag = document.createDocumentFragment();
    items.forEach(v=> frag.appendChild(buildCard(v))); mount.replaceChildren(frag);
    try { await annotateSaved(mount, items); } catch {}
  }
  async function renderRowsInto(items, mount){
    if(!mount) return; const frag = document.createDocumentFragment();
    items.forEach(v=> frag.appendChild(buildRow(v))); mount.replaceChildren(frag);
    try { await annotateSaved(mount, items); } catch {}
  }

  async function annotateSaved(container, items){
    const ids = (items||[]).map(v=> v.uuid || v.id || v.slug).filter(Boolean);
    if(!ids.length) return;
    const params = new URLSearchParams(); params.set('ids', ids.join(','));
    const r = await fetch(`/api/v1/video/playlists/contains?${params.toString()}`, { headers:{ 'Accept':'application/json' }});
    if(!r.ok) return; const data = await r.json().catch(()=>({present:[]}));
    const present = new Set(data.present||[]);
    container.querySelectorAll('[data-video-id]').forEach(a=>{
      const id = a.getAttribute('data-video-id'); if(!present.has(id)) return;
      const hero = a.querySelector('.aspect-video') || a;
      const badge = document.createElement('span'); badge.className='absolute top-2 left-2 badge'; badge.textContent='Saved'; hero.classList.add('relative'); hero.appendChild(badge);
    });
  }

  function buildCard(v) {
    const t = dom.tplCard?.content?.firstElementChild;
    const el = t ? t.cloneNode(true) : (() => {
      const a = document.createElement('a');
      a.className = 'card p-0 overflow-hidden hover:shadow-xl transition-shadow block';
      a.innerHTML = `
        <div class="w-full aspect-video bg-[color:var(--border)] relative overflow-hidden">
          <img class="w-full h-full object-cover block" alt="">
          <span class="absolute bottom-2 right-2 text-xs px-2 py-1 rounded bg-black/70 text-white">00:00</span>
        </div>
        <div class="p-3">
          <h3 class="font-semibold line-clamp-2 text-[color:var(--text)]"></h3>
          <p class="text-sm mt-1 muted line-clamp-2"></p>
          <div class="flex items-center justify-between mt-3">
            <div class="flex items-center gap-2">
              <img class="w-7 h-7 rounded-full" alt="">
              <span class="text-sm muted"></span>
            </div>
            <span class="text-xs muted"></span>
          </div>
        </div>`;
      return a;
    })();

    // lookups
    const link = el.tagName === 'A' ? el : el.querySelector('a');
    const hero = el.querySelector('.aspect-video') || el;
    const allImgs = el.querySelectorAll('img');
    const [thumb] = allImgs;
    const avatar = allImgs.length > 1 ? allImgs[1] : null;
    const title = el.querySelector('h3');
    const desc = (title && title.parentElement?.querySelector('p')) || el.querySelector('p');
    const duration = el.querySelector('span[class*="bottom-2"][class*="right-2"]');
    const metaEl = Array.from(el.querySelectorAll('.text-xs, .muted')).pop();

    // data
    const id = v.uuid ?? v.id ?? v.slug ?? '';
    const safeId = encodeURIComponent(id);
    const href = v.url || (id ? `/${safeId}` : '#');
    const titleText = (v.title || '').trim() || 'Untitled';
    const categoryTxt = (v.category_name || v.category?.name || '').trim();
    const descText = (v.description || categoryTxt || '').trim();
    const authorName = (v.author || v.channel || '').trim() || 'Unknown';
    const thumbUrl = v.thumbnail || (id ? `/api/v1/video/thumbnails/${safeId}.jpg` : placeholderThumb(id));
    const durText = fmtDuration(v.duration);
    const metaText = compactMeta(v);
    const avatarUrl = v.author_avatar || v.channel_avatar || placeholderAvatar(authorName);

    // link
    if (link) { link.href = href; link.setAttribute('aria-label', titleText); }

    // thumbnail
    if (thumb) {
      thumb.src = thumbUrl; thumb.alt = titleText; thumb.loading = 'lazy'; thumb.decoding = 'async';
      thumb.onerror = () => { if (!thumb.dataset.fbk) { thumb.dataset.fbk = '1'; thumb.src = placeholderThumb(id); } };
    }

    // avatar
    if (avatar) {
      avatar.src = avatarUrl; avatar.alt = authorName; avatar.loading = 'lazy'; avatar.decoding = 'async';
      avatar.onerror = () => { if (!avatar.dataset.fbk) { avatar.dataset.fbk = '1'; avatar.src = placeholderAvatar(authorName); } };
    }

    // text
    if (title) title.textContent = titleText;
    if (desc) desc.textContent = descText;
    if (duration) duration.textContent = durText;
    if (metaEl) metaEl.textContent = metaText;
    return el;
  }

  function buildRow(v) {
    const t = dom.tplRow?.content?.firstElementChild;
    const el = t ? t.cloneNode(true) : document.createElement('a');
    if (!t) { el.className = 'card p-3 flex gap-3'; el.href = v.url || '#'; el.textContent = v.title || 'Video'; }

    const link = el.tagName === 'A' ? el : el.querySelector('a');
    const thumb = el.querySelector('img');
    const title = el.querySelector('h3');
    const desc = el.querySelector('p');
    const av = el.querySelector('img.w-6.h-6.rounded-full');
    const who = el.querySelector('.text-xs.muted');
    const meta = el.querySelectorAll('.text-xs.muted')[1];
    const badge = el.querySelector('.badge');
    const dur = el.querySelector('.mt-1');

    const id = v.uuid ?? v.id ?? v.slug ?? '';
    const safeId = encodeURIComponent(id);
    const titleText = v.title || 'Untitled';
    const categoryTxt = v.category_name || v.category?.name || '';
    const descText = v.description || categoryTxt || '';
    const authorName = v.author || v.channel || 'Unknown';
    const avatarUrl = v.author_avatar || v.channel_avatar || placeholderAvatar(authorName);

    if (link) link.href = v.url || `/${safeId}`;
    if (thumb) { thumb.src = `/api/v1/video/thumbnails/${safeId}.jpg`; thumb.alt = titleText; }
    if (title) title.textContent = titleText;
    if (desc) desc.textContent = descText;
    if (av) { av.src = avatarUrl; av.alt = authorName; }
    if (who) who.textContent = authorName;
    if (meta) meta.textContent = compactMeta(v);
    if (badge) badge.textContent = 'HD';
    if (dur) dur.textContent = fmtDuration(v.duration);

    // add-to-playlist floating button
    try{
      const id = v.uuid ?? v.id ?? v.slug ?? '';
      const btn = document.createElement('button');
      btn.type='button'; btn.className='absolute left-2 bottom-2 z-10 text-xs px-2 py-1 rounded bg-black/60 text-white hover:bg-black/80';
      btn.textContent='＋ Playlist';
      btn.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); if(window.playlistMulti){ window.playlistMulti.show(id); } });
      hero?.appendChild(btn); hero?.classList.add('relative');
    }catch{}
    return el;
  }

  function fmtDuration(sec){ const s = Math.max(0, Math.floor(Number(sec) || 0)); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), r = s%60; return (h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(r).padStart(2,'0'); }
  function formatCompact(n){ const x = Number(n)||0; if(x>=1_000_000) return (x/1_000_000).toFixed(1).replace(/\.0$/,'')+'M'; if(x>=1_000) return (x/1_000).toFixed(1).replace(/\.0$/,'')+'K'; return String(x); }
  function formatAge(dateish){ try{ const d=new Date(dateish); const diff=Math.max(0,(Date.now()-d.getTime())/1000); const day=86400, week=day*7, month=day*30, year=day*365; if(diff<day) return 'today'; if(diff<week) return `${Math.floor(diff/day)} d ago`; if(diff<month) return `${Math.floor(diff/week)} w ago`; if(diff<year) return `${Math.floor(diff/month)} mo ago`; return `${Math.floor(diff/year)} y ago`; } catch { return ''; } }
  function compactMeta(v){ const views=v.views??v.view_count; const age=v.published_at||v.date||v.created_at; const parts=[]; if(views!=null) parts.push(`${formatCompact(views)} views`); if(age) parts.push(formatAge(age)); return parts.join(' • '); }
  function placeholderThumb(id){
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'><rect width='16' height='9' fill='%23ddd'/><path d='M0 9 L5.5 4.5 L9 7 L12 5 L16 9 Z' fill='%23bbb'/></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }
  function placeholderAvatar(seed){
    const s = String(seed||'u');
    const color = '#'+((Math.abs(hashCode(s))>>8)&0xFFFFFF).toString(16).padStart(6,'0');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='%23f2f2f2'/><circle cx='32' cy='24' r='14' fill='${color}'/><rect x='14' y='40' width='36' height='18' rx='9' fill='${color}'/></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }
  function hashCode(str){ let h=0; for(let i=0;i<str.length;i++) h=(Math.imul(31,h)+str.charCodeAt(i))|0; return h; }

  init();
})();
