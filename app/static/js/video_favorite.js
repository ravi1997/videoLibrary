// Favourite toggle logic (extracted from inline script for CSP compliance)
(function(){
  const BASE = '/video';
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('favBtn');
    if(!btn) return;
    const videoId = document.getElementById('video-id')?.textContent?.trim() || btn.dataset.videoId;
    if(!videoId) return;

    const getToken = () => localStorage.getItem('token') || '';
    const withAuth = (opts={}) => {
      const token = getToken();
      return {
        ...opts,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(opts.headers||{}),
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        }
      };
    };
    const API = {
      status: `${BASE}/api/v1/video/${encodeURIComponent(videoId)}/favorite`,
      toggle: `${BASE}/api/v1/video/${encodeURIComponent(videoId)}/favorite`,
    };
    let fav = false; let busy = false;
    function renderFav(){
      btn.innerHTML = fav ? "💖 <span class='text-sm'>Favourited</span>" : "❤️ <span class='text-sm'>Favourite</span>";
      btn.classList.toggle('bg-[color:var(--brand-50)]', fav);
      btn.ariaPressed = String(!!fav);
    }
    function setBusy(on){ busy = on; btn.disabled = !!on; btn.style.opacity = on?0.7:1; }
    async function loadInitial(){
      try {
        const res = await fetch(API.status, withAuth({method:'GET'}));
        if(!res.ok) throw new Error(res.status);
        const data = await res.json().catch(()=>({}));
        fav = !!(data.favorite ?? data.is_favorite ?? data.favourited);
      } catch(_) { /* ignore */ } finally { renderFav(); }
    }
    async function persist(next){
      const method = next ? 'POST' : 'DELETE';
      const res = await fetch(API.toggle, withAuth({method}));
      if(res.status === 401){
        alert('Please login to use favourites.');
        window.location.href = BASE + '/login';
        throw new Error('Unauthorized');
      }
      if(!res.ok) throw new Error(res.status);
    }
    btn.addEventListener('click', async () => {
      if(busy) return; const next = !fav; fav = next; renderFav(); setBusy(true);
      try { await persist(next); } catch(e){ fav = !next; renderFav(); console.error('Fav failed', e); } finally { setBusy(false); }
    });
    renderFav(); loadInitial();
  });
})();
