(function(){
  const BASE = '/video';
  const root = document.querySelector('[data-pid]'); if(!root) return;
  const pid = root.getAttribute('data-pid');
  const playerEl = document.getElementById('plPlayer');
  const prevBtn = document.getElementById('btnPrev');
  const nextBtn = document.getElementById('btnNext');
  const listEl = document.getElementById('plItems');
  const nowEl = document.getElementById('nowPlaying');
  const recsEl = document.getElementById('plRecs');
  let current = ''; let items = []; let index = 0; let vjs = null;

  function escapeHtml(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;"); }

  async function fetchJSON(url){ const r = await fetch(url, { headers:{ 'Accept':'application/json' }}); return r.json(); }

  async function loadNext(start=false){
    const url = `${BASE}/api/v1/video/playlists/${pid}/next${current?`?current=${encodeURIComponent(current)}`:''}`;
    const data = await fetchJSON(url);
    if(!data || !data.item){ return; }
    index = data.index || 0; current = data.item.video_id;
    const src = `${BASE}/api/v1/video/hls/${encodeURIComponent(current)}/master.m3u8`;
    mountPlayer(src);
    renderSidebar();
    try{ const recs = await fetchJSON(`${BASE}/api/v1/video/playlists/${pid}/recommended?current=${encodeURIComponent(current)}`); renderRecs(recs?.items||[]);}catch{}
  }

  function mountPlayer(src){
    try{ if(window.videojs){ if(vjs){ vjs.src({ src, type:'application/vnd.apple.mpegurl' }); vjs.play(); } else { vjs = window.videojs(playerEl, { fluid:true }); vjs.src({ src, type:'application/vnd.apple.mpegurl' }); } return; } }catch{}
    playerEl.innerHTML=''; const s = document.createElement('source'); s.src = src; s.type='application/vnd.apple.mpegurl'; playerEl.appendChild(s);
  }

  function renderSidebar(){
    listEl.innerHTML='';
    // lazy load all items when not fetched
    if(!items.length){
      // fetch first page large
      fetchJSON(`${BASE}/api/v1/video/playlists/${pid}/items?page=1&page_size=500`).then(d=>{ items = d.items||[]; renderSidebar(); });
      return;
    }
    items.forEach((it,i)=>{
      const row = document.createElement('a');
      row.href = `${BASE}/${encodeURIComponent(it.video_id)}`;
      row.className = `card p-2 flex items-center gap-2 ${i===index?'ring-1 ring-[color:var(--brand-600)]':''}`;
      row.innerHTML = `<img src="${BASE}/api/v1/video/thumbnails/${it.video_id}.jpg" alt="" class="w-16 h-10 object-cover rounded"><div class="text-sm">${escapeHtml(it?.video?.title||it.video_id)}</div>`;
      row.addEventListener('click', (e)=>{ e.preventDefault(); current = it.video_id; loadNext(); });
      listEl.appendChild(row);
    });
    const it = items[index]; nowEl.textContent = it ? `Now Playing • ${escapeHtml(it?.video?.title||it.video_id)}` : '';
    prevBtn.disabled = index<=0; nextBtn.disabled = index>=items.length-1;
  }

  function renderRecs(arr){
    recsEl.innerHTML='';
    arr.forEach(v=>{
      const a = document.createElement('a'); a.href = `/${encodeURIComponent(v.uuid||'')}`; a.className='card p-2 no-underline';
      a.innerHTML = `<img class="w-full h-32 object-cover rounded" src="${v.thumbnail}" alt=""><div class="mt-1 text-sm">${escapeHtml(v.title||'')}</div>`;
      recsEl.appendChild(a);
    });
  }

  prevBtn?.addEventListener('click', ()=>{ if(index>0){ current = items[index-1].video_id; loadNext(); } });
  nextBtn?.addEventListener('click', ()=>{ loadNext(); });

  // Seed items first so sidebar can show
  fetchJSON(`${BASE}/api/v1/video/playlists/${pid}/items?page=1&page_size=500`).then(d=>{ items = d.items||[]; renderSidebar(); loadNext(true); });
})();
