// History page logic (extracted from template to satisfy strict CSP)
(() => {
  const API = {
    list: "/api/v1/video/history?page={page}&page_size={size}&sort={sort}",
    remove: (id) => `/api/v1/video/history/${encodeURIComponent(id)}`,
    clear: "/api/v1/video/history"
  };
  const PAGE_SIZE = 12;
  const state = {
    view: localStorage.getItem("hist.view") || "grid",
    sort: localStorage.getItem("hist.sort") || "recent",
    page: +(localStorage.getItem("hist.page") || 1),
    pages: 1,
    total: 0,
    items: [],
    totalWatchedSec: 0
  };
  const $ = (s, r = document) => r.querySelector(s);
  const histGrid = $("#histGrid");
  const emptyState = $("#emptyState");
  const totalCount = $("#totalCount");
  const totalWatched = $("#totalWatched");
  const pageNumber = $("#pageNumber");
  const prevBtn = $("#prevBtn");
  const nextBtn = $("#nextBtn");
  const viewToggle = $("#viewToggle");
  const clearAll = $("#clearAll");
  const sortBtns = Array.from(document.querySelectorAll(".sort-btn"));

  function init() {
    viewToggle?.addEventListener("click", () => {
      state.view = state.view === "grid" ? "list" : "grid";
      persist();
      render(state.items);
    });
    sortBtns.forEach(b => b.addEventListener("click", () => {
      state.sort = b.dataset.sort || "recent";
      persist();
      render(state.items);
    }));
    prevBtn?.addEventListener("click", () => changePage(-1));
    nextBtn?.addEventListener("click", () => changePage(1));
    clearAll?.addEventListener("click", onClearAll);
    refresh();
  }
  function persist() {
    localStorage.setItem("hist.view", state.view);
    localStorage.setItem("hist.sort", state.sort);
    localStorage.setItem("hist.page", String(state.page));
  }
  function changePage(delta) {
    const next = Math.min(Math.max(1, state.page + delta), state.pages || 1);
    if (next === state.page) return;
    state.page = next;
    persist();
    refresh();
  }
  async function refresh() {
    const url = API.list
      .replace("{page}", encodeURIComponent(state.page))
      .replace("{size}", encodeURIComponent(PAGE_SIZE))
      .replace("{sort}", encodeURIComponent(state.sort));
    try {
      const res = await fetch(url, {
        headers: { "Accept": "application/json", "Authorization": `Bearer ${localStorage.getItem("token") || ""}` }
      });
      if (res.status === 401) { window.location.href = "/login"; return; }
      const data = await res.json();
      state.items = data.items || [];
      state.total = (data.count ?? data.total ?? state.items.length) || 0;
      state.page = data.page || state.page;
      state.pages = data.pages || Math.max(1, Math.ceil(state.total / PAGE_SIZE));
      state.totalWatchedSec = data.total_watched_sec ?? sumWatched(state.items);
      render(state.items);
    } catch (e) {
      console.error("History load failed:", e);
      state.items = [];
      state.total = 0;
      state.pages = 1;
      state.totalWatchedSec = 0;
      render(state.items);
    }
  }
  function render(items) {
    if (state.sort === "alpha") items.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    else if (state.sort === "progress") items.sort((a, b) => progress(b) - progress(a));
    else items.sort((a, b) => new Date(b.last_watched_at || 0) - new Date(a.last_watched_at || 0));
    if (totalCount) totalCount.textContent = String(state.total);
    if (totalWatched) totalWatched.textContent = fmtHMS(state.totalWatchedSec);
    if (pageNumber) pageNumber.textContent = `Page ${state.page} of ${state.pages || 1}`;
    disable(prevBtn, state.page <= 1);
    disable(nextBtn, state.page >= (state.pages || 1));
    if (!items.length) { emptyState?.classList.remove("hidden"); histGrid?.replaceChildren(); return; } else emptyState?.classList.add("hidden");
    if (state.view === "list") { histGrid.classList.remove("grid"); histGrid.classList.add("list-view"); }
    else { histGrid.classList.remove("list-view"); histGrid.classList.add("grid"); }
    const frag = document.createDocumentFragment();
    items.forEach(v => frag.appendChild(state.view === "list" ? row(v) : card(v)));
    histGrid.replaceChildren(frag);
    sortBtns.forEach(b => { const active = b.dataset.sort === state.sort; b.classList.toggle("ring-1", active); b.classList.toggle("ring-[color:var(--brand-600)]", active); b.classList.toggle("font-semibold", active); });
  }
  function card(v) {
    const art = document.createElement("article");
    art.className = "card p-0 overflow-hidden hover:shadow-xl transition-shadow";
    art.innerHTML = `
<a class="block relative group" href="${escapeAttr(v.url || `/${encodeURIComponent(v.id || "")}`)}" aria-label="${escapeAttr(v.title || "Video")}">
  <div class="w-full aspect-video bg-[color:var(--border)] relative overflow-hidden">
    <img class="w-full h-full object-cover block" src="${escapeAttr(thumb(v))}" alt="${escapeAttr(v.title || "Video")}" loading="lazy" decoding="async">
    <span class="absolute bottom-2 right-2 text-xs px-2 py-1 rounded bg-black/70 text-white">${fmtDuration(v.duration)}</span>
    ${progressBarHTML(v)}
  </div>
  <div class="p-3">
    <h3 class="font-semibold line-clamp-2 text-[color:var(--text)]">${escapeHtml(v.title || "Untitled")}</h3>
    <p class="text-sm mt-1 muted line-clamp-2">${escapeHtml(v.description || v.category_name || "")}</p>
    <div class="flex items-center justify-between mt-3">
      <span class="text-xs muted">${escapeHtml(meta(v))}</span>
      <div class="flex items-center gap-2">
        <button data-resume="${escapeAttr(v.id || "")}" class="text-xs px-2 py-1 rounded border border-[color:var(--border)] hover:bg-[color:var(--brand-50)]">Resume</button>
        <button data-remove="${escapeAttr(v.id || "")}" class="text-xs px-2 py-1 rounded border border-[color:var(--border)] hover:bg-[color:var(--brand-50)]">Remove</button>
      </div>
    </div>
  </div>
</a>`;
    art.querySelector("button[data-remove]")?.addEventListener("click", onRemoveOne);
    art.querySelector("button[data-resume]")?.addEventListener("click", onResume);
    return art;
  }
  function row(v) {
    const a = document.createElement("a");
    a.className = "card p-3 flex gap-3 items-center hover:shadow-xl transition-shadow";
    a.href = v.url || `/${encodeURIComponent(v.id || "")}`;
    a.innerHTML = `
<div class="w-48 shrink-0 aspect-video rounded-lg overflow-hidden bg-[color:var(--border)] relative">
  <img class="w-full h-full object-cover block" src="${escapeAttr(thumb(v))}" alt="${escapeAttr(v.title || "Video")}" loading="lazy" decoding="async">
  ${progressBarHTML(v)}
</div>
<div class="min-w-0 flex-1">
  <h3 class="font-semibold text-[color:var(--text)] line-clamp-1">${escapeHtml(v.title || "Untitled")}</h3>
  <p class="text-sm muted mt-1 line-clamp-2">${escapeHtml(v.description || v.category_name || "")}</p>
  <div class="text-xs muted mt-2">${escapeHtml(meta(v))}</div>
</div>
<div class="shrink-0 flex flex-col items-end gap-2">
  <div class="text-xs muted">${fmtDuration(v.duration)}</div>
  <div class="flex items-center gap-2">
    <button data-resume="${escapeAttr(v.id || "")}" class="text-xs px-2 py-1 rounded border border-[color:var(--border)] hover:bg-[color:var(--brand-50)]">Resume</button>
    <button data-remove="${escapeAttr(v.id || "")}" class="text-xs px-2 py-1 rounded border border-[color:var(--border)] hover:bg-[color:var(--brand-50)]">Remove</button>
  </div>
</div>`;
    a.querySelector("button[data-remove]")?.addEventListener("click", onRemoveOne);
    a.querySelector("button[data-resume]")?.addEventListener("click", onResume);
    return a;
  }
  function progressBarHTML(v) {
    const pct = Math.max(0, Math.min(100, Math.round(progress(v) * 100)));
    return `<div class="absolute left-0 right-0 bottom-0 h-1 bg-black/20" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="h-full bg-[color:var(--brand-600)]" style="width:${pct}%"></div></div>`;
  }
  async function onRemoveOne(e) {
    e.preventDefault(); e.stopPropagation();
    const id = e.currentTarget?.getAttribute("data-remove");
    if (!id) return;
    const prev = state.items.slice();
    state.items = state.items.filter(v => String(v.id) !== String(id));
    state.total = Math.max(0, state.total - 1);
    state.totalWatchedSec = sumWatched(state.items);
    render(state.items);
    try {
      const res = await fetch(API.remove(id), { method: "DELETE", headers: { "Accept": "application/json", "Authorization": `Bearer ${localStorage.getItem("token") || ""}` } });
      if (!res.ok) throw new Error("http " + res.status);
    } catch (err) {
      console.error("Remove failed", err);
      state.items = prev; state.total = prev.length; state.totalWatchedSec = sumWatched(prev); render(state.items);
      alert("Could not remove from history. Please try again.");
    }
  }
  async function onClearAll() {
    if (!confirm("Clear your entire watch history?")) return;
    const prev = state.items.slice();
    state.items = []; state.total = 0; state.totalWatchedSec = 0; render(state.items);
    try {
      const res = await fetch(API.clear, { method: "DELETE", headers: { "Accept": "application/json", "Authorization": `Bearer ${localStorage.getItem("token") || ""}` } });
      if (!res.ok) throw new Error("http " + res.status);
    } catch (err) {
      console.error("Clear failed", err);
      state.items = prev; state.total = prev.length; state.totalWatchedSec = sumWatched(prev); render(state.items);
      alert("Could not clear history. Please try again.");
    }
  }
  function onResume(e) {
    e.preventDefault(); e.stopPropagation();
    const id = e.currentTarget?.getAttribute("data-resume");
    const item = state.items.find(v => String(v.id) === String(id));
    if (!item) return;
    const seconds = Math.max(0, Math.floor(+item.position || 0));
    const href = (item.url || `/${encodeURIComponent(item.id || "")}`) + (seconds ? `?t=${seconds}` : "");
    window.location.href = href;
  }
  function thumb(v) { return v.thumbnail || (v.id ? `/api/v1/video/thumbnails/${encodeURIComponent(v.id)}.jpg` : `https://picsum.photos/seed/h${Math.floor(Math.random() * 10)}/640/360`); }
  function fmtDuration(sec) { const s = Number.isFinite(+sec) ? Math.max(0, Math.round(+sec)) : 0; const m = Math.floor(s / 60), r = s % 60; return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`; }
  function fmtHMS(sec) { const s = Math.max(0, Math.round(+sec || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}h ${m}m` : `${m}m ${r}s`; }
  function progress(v) { const pos = Number(v.position); const dur = Number(v.duration); if (!Number.isFinite(pos) || !Number.isFinite(dur) || dur <= 0) return 0; return Math.min(1, Math.max(0, pos / dur)); }
  function meta(v) { const parts = []; if (v.last_watched_at) parts.push(new Date(v.last_watched_at).toLocaleString()); const pct = Math.round(progress(v) * 100); parts.push(`${pct}% watched`); return parts.join(" • "); }
  function sumWatched(items) { return items.reduce((acc, v) => acc + Math.min(+v.position || 0, +v.duration || 0), 0); }
  function disable(el, on) { if (!el) return; el.disabled = !!on; el.style.opacity = on ? 0.6 : 1; el.style.pointerEvents = on ? "none" : "auto"; }
  function escapeHtml(s) { return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function escapeAttr(s) { return String(s).replaceAll('"', "&quot;"); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
